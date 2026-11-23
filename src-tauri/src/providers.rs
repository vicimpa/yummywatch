use base64::{
    alphabet,
    engine::{
        general_purpose::{GeneralPurpose, GeneralPurposeConfig},
        DecodePaddingMode,
    },
    Engine,
};
use regex::Regex;
use reqwest::{header::HeaderMap, Client};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::BTreeMap, time::Duration};
use url::Url;

use crate::skips::provider_skips;

pub type Result<T> = std::result::Result<T, String>;

pub(crate) const AKSOR_MEDIA_REFERER: &str = "https://player.aksor.tv/";

pub(crate) fn is_aksor_media_url(url: &Url) -> bool {
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && url
            .host_str()
            .is_some_and(|host| host == "old.tut-video.net" || host.ends_with(".aksor.tv"))
}

#[cfg(any(desktop, target_os = "android"))]
pub(crate) fn native_aksor_referrer(url: &std::ffi::CStr) -> Option<std::ffi::CString> {
    let url = Url::parse(url.to_str().ok()?).ok()?;
    is_aksor_media_url(&url).then(|| std::ffi::CString::new(AKSOR_MEDIA_REFERER).unwrap())
}

#[derive(Clone, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub url: String,
    pub video_id: u64,
    #[serde(default)]
    pub dubbing: String,
    #[serde(default)]
    pub episode: String,
}

#[derive(Default)]
pub struct Request {
    pub form: Option<BTreeMap<String, String>>,
    pub headers: HeaderMap,
}

pub trait Upstream: Send + Sync {
    fn text(
        &self,
        url: &str,
        request: Request,
    ) -> impl std::future::Future<Output = Result<String>> + Send;
}

impl Upstream for Client {
    async fn text(&self, url: &str, request: Request) -> Result<String> {
        let builder = if let Some(form) = request.form {
            self.post(url).form(&form)
        } else {
            self.get(url)
        };
        let builder = builder
            .headers(request.headers)
            .timeout(Duration::from_secs(12));
        let response = if matches!(provider_url(url), Ok((_, "kodik" | "aksor"))) {
            send_with_server_retry(builder).await
        } else {
            builder.send().await
        }
        .map_err(|_| "Нет связи с источником.".to_string())?;
        let bytes = limited_body(response, 2_000_000).await?;
        // Match Fetch/Response.text(): replace invalid UTF-8 and strip a BOM.
        Ok(String::from_utf8_lossy(&bytes)
            .trim_start_matches('\u{feff}')
            .to_owned())
    }
}

pub(crate) async fn send_with_server_retry(
    builder: reqwest::RequestBuilder,
) -> reqwest::Result<reqwest::Response> {
    let retry = builder.try_clone();
    let response = builder.send().await?;
    if let Some(retry) = retry.filter(|_| response.status().is_server_error()) {
        drop(response);
        tokio::time::sleep(Duration::from_millis(300)).await;
        return retry.send().await;
    }
    Ok(response)
}

pub(crate) fn should_retry_with_proxy(message: &str) -> bool {
    if message == "Aksor · нет манифеста DASH (HTTP 203)." {
        return true;
    }
    if [
        "Нет связи с источником.",
        "Источник прервал ответ.",
        "Источник не ответил вовремя.",
    ]
    .iter()
    .any(|error| message.ends_with(error))
    {
        return true;
    }
    message
        .rsplit_once("HTTP ")
        .and_then(|(_, status)| status.strip_suffix('.'))
        .map(|status| status.trim_end_matches(')'))
        .and_then(|status| status.parse::<u16>().ok())
        .is_some_and(|status| matches!(status, 403 | 451 | 500..=599))
}

pub async fn limited_body(mut response: reqwest::Response, limit: usize) -> Result<Vec<u8>> {
    if !response.status().is_success() {
        return Err(format!(
            "Источник вернул HTTP {}.",
            response.status().as_u16()
        ));
    }
    if response
        .content_length()
        .is_some_and(|size| size > limit as u64)
    {
        return Err("Слишком большой ответ источника.".into());
    }
    let mut result = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Источник прервал ответ.".to_string())?
    {
        if result.len() + chunk.len() > limit {
            return Err("Слишком большой ответ источника.".into());
        }
        result.extend_from_slice(&chunk);
    }
    Ok(result)
}

pub fn request(
    headers: &[(&str, &str)],
    form: Option<BTreeMap<String, String>>,
) -> Result<Request> {
    let mut values = HeaderMap::new();
    for (name, value) in headers {
        values.insert(
            reqwest::header::HeaderName::from_bytes(name.as_bytes())
                .map_err(|_| "Некорректный заголовок.")?,
            value.parse().map_err(|_| "Некорректный заголовок.")?,
        );
    }
    Ok(Request {
        form,
        headers: values,
    })
}

pub fn provider_url(raw: &str) -> Result<(Url, &'static str)> {
    let url = Url::parse(&if raw.starts_with("//") {
        format!("https:{raw}")
    } else {
        raw.into()
    })
    .map_err(|_| "Недопустимый адрес источника.".to_string())?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
    {
        return Err("Недопустимый адрес источника.".into());
    }
    let family = match url.host_str().unwrap_or("") {
        "player.aksor.tv" => "aksor",
        "kodikplayer.com" | "kodikplayer.org" | "kodik.info" | "kodik.cc" => "kodik",
        "ru.yummyani.me" | "yummyani.me" if url.path().ends_with("/iframeCVH.html") => "cvh",
        "alloha.yani.tv" | "alloha.tv" | "streamalloha.live" => "alloha",
        _ => return Err("Источник не поддерживается.".into()),
    };
    Ok((url, family))
}

fn https_media(raw: &str) -> Result<String> {
    let url = Url::parse(&if raw.starts_with("//") {
        format!("https:{raw}")
    } else {
        raw.into()
    })
    .map_err(|_| "Некорректный поток.".to_string())?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        return Err("Источник вернул некорректный поток.".into());
    }
    Ok(url.into())
}

pub fn decode_kodik(raw: &str) -> Result<String> {
    if raw.contains("//") {
        return https_media(raw);
    }
    let rotated: Vec<u8> = raw
        .bytes()
        .map(|c| {
            if c.is_ascii_alphabetic() {
                let base = if c.is_ascii_uppercase() { b'A' } else { b'a' };
                (c - base + 18) % 26 + base
            } else {
                c
            }
        })
        .collect();
    // Browser atob accepts unpadded base64 and non-zero unused trailing bits.
    // Provider links use that form; Rust's default STANDARD decoder rejects it.
    const DECODER: GeneralPurpose = GeneralPurpose::new(
        &alphabet::STANDARD,
        GeneralPurposeConfig::new()
            .with_decode_padding_mode(DecodePaddingMode::Indifferent)
            .with_decode_allow_trailing_bits(true),
    );
    let rotated: Vec<_> = rotated
        .into_iter()
        .filter(|c| !matches!(c, b' ' | b'\t' | b'\n' | b'\r' | 0x0c))
        .collect();
    let decoded = DECODER
        .decode(rotated)
        .map_err(|_| "Некорректная ссылка Kodik.".to_string())?;
    https_media(
        std::str::from_utf8(&decoded).map_err(|_| "Некорректная ссылка Kodik.".to_string())?,
    )
}

pub fn kodik_fields(html: &str) -> Result<BTreeMap<String, String>> {
    let mut fields = BTreeMap::new();
    for (variable, key) in [
        ("domain", "d"),
        ("d_sign", "d_sign"),
        ("pd", "pd"),
        ("pd_sign", "pd_sign"),
        ("ref", "ref"),
        ("ref_sign", "ref_sign"),
    ] {
        let pattern = Regex::new(&format!(
            r#"var\s+{variable}\s*=\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')"#
        ))
        .unwrap();
        if let Some(captures) = pattern.captures(html) {
            let value = &captures[1];
            let value = if value.starts_with('"') {
                serde_json::from_str(value).map_err(|_| "Некорректные данные Kodik.".to_string())?
            } else {
                value[1..value.len() - 1].into()
            };
            fields.insert(key.into(), value);
        }
    }
    for key in ["type", "id", "hash"] {
        let pattern = Regex::new(&format!(r#"vInfo\.{key}\s*=\s*['"]([^'"]+)"#)).unwrap();
        if let Some(captures) = pattern.captures(html) {
            fields.insert(key.into(), captures[1].into());
        }
    }
    if ["id", "hash", "d_sign"]
        .iter()
        .any(|key| fields.get(*key).is_none_or(String::is_empty))
    {
        return Err("Формат страницы Kodik изменился.".into());
    }
    Ok(fields)
}

pub fn voice_key(value: &str) -> String {
    let key = studio_name(value)
        .replace("aniliberty", "anilibria")
        .replace("anilibriatv", "anilibria")
        .replace("anidubonline", "anidub");
    match key.as_str() {
        "jamclub" => "jam".into(),
        "мсentertainment" => "mcentertainment".into(),
        _ => key,
    }
}
fn studio_name(value: &str) -> String {
    Regex::new(r"озвучка|субтитры|[^a-zа-яё0-9]")
        .unwrap()
        .replace_all(&value.to_lowercase(), "")
        .into_owned()
}

pub fn alloha_voice(value: &str) -> String {
    let stripped = Regex::new(r"\([^)]*\)").unwrap().replace_all(value, "");
    voice_key(
        &Regex::new(r"(?i)^\s*(?:dub|dvo|mvo|vo)\s*[-:]\s*")
            .unwrap()
            .replace(&stripped, ""),
    )
}

fn media_type(url: &str) -> &'static str {
    if url.contains(".m3u8") {
        "hls"
    } else if url.contains(".mpd") {
        "dash"
    } else {
        "mp4"
    }
}

pub async fn resolve(candidate: &Candidate, upstream: &impl Upstream) -> Result<Value> {
    let (url, family) = provider_url(&candidate.url)?;
    let (provider, data, html, streams) = match family {
        "aksor" => {
            let pattern = Regex::new(r"^/video/([a-zA-Z0-9_-]+)/?$").unwrap();
            let id = pattern
                .captures(url.path())
                .ok_or("Неизвестный адрес Aksor.")?;
            let data: Value = serde_json::from_str(
                &upstream
                    .text(
                        &format!("https://player.aksor.tv/api/video/{}", &id[1]),
                        Request::default(),
                    )
                    .await
                    .map_err(|error| format!("Aksor · список потоков. {error}"))?,
            )
            .map_err(|_| "Некорректный ответ Aksor.")?;
            let mut streams = Vec::new();
            for (key, quality) in [
                ("q360", 360),
                ("q480", 480),
                ("q720", 720),
                ("q1080", 1080),
                ("q2k", 1440),
                ("q4k", 2160),
            ] {
                if let Some(raw) = data["qualities"][key].as_str().filter(|v| !v.is_empty()) {
                    streams.push(json!({"quality": quality, "url": https_media(raw)?, "type": media_type(raw)}));
                }
            }
            ("Aksor", data, String::new(), streams)
        }
        "kodik" => {
            let html = upstream
                .text(url.as_str(), Request::default())
                .await
                .map_err(|error| format!("Kodik · страница плеера. {error}"))?;
            let data: Value = serde_json::from_str(
                &upstream
                    .text(
                        &format!("{}/ftor", url.origin().ascii_serialization()),
                        request(
                            &[
                                ("Origin", &url.origin().ascii_serialization()),
                                ("Referer", url.as_str()),
                            ],
                            Some(kodik_fields(&html)?),
                        )?,
                    )
                    .await
                    .map_err(|error| format!("Kodik · список потоков. {error}"))?,
            )
            .map_err(|_| "Некорректный ответ Kodik.")?;
            let mut streams = Vec::new();
            if let Some(links) = data["links"].as_object() {
                for (quality, values) in links {
                    if let (Ok(quality), Some(raw)) =
                        (quality.parse::<u32>(), values[0]["src"].as_str())
                    {
                        if quality > 0 {
                            let decoded = decode_kodik(raw)?;
                            let mut media =
                                Url::parse(&decoded).map_err(|_| "Некорректная ссылка Kodik.")?;
                            let mut stream = json!({
                                "quality": quality,
                                "type": media_type(&decoded),
                                "url": decoded,
                            });
                            // Keep segmented startup; probing a full MP4 can take
                            // many seconds. Old TS releases still need native MP4
                            // when their later segments cannot be transmuxed.
                            if let Some(path) = media
                                .path()
                                .strip_suffix(":hls:manifest.m3u8")
                                .filter(|path| path.ends_with(".mp4"))
                                .map(str::to_owned)
                            {
                                media.set_path(&path);
                                stream["fallback"] = json!({"type":"mp4", "url":media.to_string()});
                            }
                            streams.push(stream);
                        }
                    }
                }
            }
            ("Kodik", data, html, streams)
        }
        "cvh" => {
            let query: BTreeMap<_, _> = url.query_pairs().into_owned().collect();
            let id = query
                .get("anime_id")
                .filter(|id| !id.is_empty() && id.bytes().all(|c| c.is_ascii_digit()))
                .ok_or("Не указан релиз CVH.")?;
            let episode: f64 = query
                .get("episode")
                .or(Some(&candidate.episode))
                .and_then(|s| s.parse().ok())
                .filter(|n: &f64| n.is_finite())
                .ok_or("Не указана серия CVH.")?;
            let playlist: Value = serde_json::from_str(&upstream.text(&format!("https://plapi.cdnvideohub.com/api/v1/player/sv/playlist?pub=745&aggr=mali&id={id}"), request(&[("Origin", "https://vicimpa.github.io")], None)?).await?).map_err(|_| "Некорректный ответ CVH.")?;
            let lower = candidate.dubbing.to_lowercase();
            let dubbed = lower.starts_with("дубляж ");
            let label = Regex::new(r"(?i)^дубляж\s+")
                .unwrap()
                .replace(&candidate.dubbing, "")
                .into_owned();
            let code = query.get("dubbing_code");
            let item = playlist["items"]
                .as_array()
                .and_then(|items| {
                    items
                        .iter()
                        .filter(|item| {
                            (item["episode"].as_f64().or_else(|| {
                                item["episode"]
                                    .as_str()
                                    .and_then(|value| value.parse::<f64>().ok())
                            }) == Some(episode)
                                || playlist["isSerial"].as_bool() == Some(false)
                                    && item["episode"].is_null()
                                    && episode == 1.0)
                                && (voice_key(item["voiceStudio"].as_str().unwrap_or(""))
                                    == voice_key(&label)
                                    || code.is_some_and(|code| {
                                        voice_key(item["voiceStudio"].as_str().unwrap_or(""))
                                            == voice_key(code)
                                    }))
                                && (!dubbed
                                    || item["voiceType"]
                                        .as_str()
                                        .unwrap_or("")
                                        .to_lowercase()
                                        .contains("дубляж"))
                                && item["voiceType"]
                                    .as_str()
                                    .unwrap_or("")
                                    .to_lowercase()
                                    .contains("субтитры")
                                    == candidate.dubbing.to_lowercase().contains("субтитры")
                        })
                        .min_by_key(|item| {
                            (
                                code.is_some_and(|code| {
                                    studio_name(item["voiceStudio"].as_str().unwrap_or(""))
                                        != studio_name(code)
                                }),
                                !dubbed
                                    && item["voiceType"]
                                        .as_str()
                                        .unwrap_or("")
                                        .to_lowercase()
                                        .contains("дубляж"),
                            )
                        })
                })
                .ok_or("В CVH нет этой серии в выбранной озвучке.")?;
            let id = item["vkId"]
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| item["vkId"].to_string());
            if id.is_empty() || !id.bytes().all(|c| c.is_ascii_digit()) {
                return Err("Некорректная серия CVH.".into());
            }
            let data: Value = serde_json::from_str(
                &upstream
                    .text(
                        &format!("https://plapi.cdnvideohub.com/api/v1/player/sv/video/{id}"),
                        request(&[("Origin", "https://vicimpa.github.io")], None)?,
                    )
                    .await?,
            )
            .map_err(|_| "Некорректный ответ CVH.")?;
            let mut streams = Vec::new();
            #[cfg(desktop)]
            let mut download_mp4 = Vec::new();
            for (key, quality) in [
                ("mpegTinyUrl", 144),
                ("mpegLowestUrl", 240),
                ("mpegLowUrl", 360),
                ("mpegMediumUrl", 480),
                ("mpegHighUrl", 720),
                ("mpegFullHdUrl", 1080),
            ] {
                if let Some(raw) = data["sources"][key].as_str().filter(|v| !v.is_empty()) {
                    if let Some(hls) = data["sources"]["hlsUrl"].as_str().filter(|v| !v.is_empty())
                    {
                        streams
                            .push(json!({"quality":quality,"url":https_media(hls)?,"type":"hls"}));
                        #[cfg(desktop)]
                        if let Ok(url) = https_media(raw) {
                            download_mp4.push(json!({"quality":quality,"url":url,"type":"mp4"}));
                        }
                    } else {
                        streams.push(
                            json!({"quality": quality,"url": https_media(raw)?,"type":"mp4"}),
                        );
                    }
                }
            }
            #[cfg(desktop)]
            {
                let mut data = data;
                data["downloadMp4"] = json!(download_mp4);
                ("CVH", data, String::new(), streams)
            }
            #[cfg(not(desktop))]
            ("CVH", data, String::new(), streams)
        }
        _ => return Err("Для Alloha нужна сессия ретрансляции.".into()),
    };
    if streams.is_empty() {
        return Err("Источник не предоставил видео.".into());
    }
    let result = json!({"provider":provider,"duration":data["duration"].as_f64().unwrap_or(0.0),"videoId":candidate.video_id,"streams":streams,"skips":provider_skips(&data, &html)});
    #[cfg(desktop)]
    if let Some(reserves) = data["downloadMp4"].as_array().filter(|_| provider == "CVH") {
        let mut result = result;
        result["downloadMp4"] = json!(reserves);
        return Ok(result);
    }
    Ok(result)
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use base64::engine::general_purpose::STANDARD;
    use std::{collections::VecDeque, sync::Mutex};

    #[test]
    fn recognizes_aksor_media_hosts() {
        for url in [
            "https://old.tut-video.net/a.mpd",
            "https://cdn10.takehost-cdn.aksor.tv/a.mpd",
        ] {
            assert!(is_aksor_media_url(&Url::parse(url).unwrap()));
        }
        for url in [
            "http://old.tut-video.net/a.mpd",
            "https://old.tut-video.net:8080/a.mpd",
            "https://user@old.tut-video.net/a.mpd",
            "https://old.tut-video.net.example.org/a.mpd",
            "https://anotheraksor.tv/a.mpd",
        ] {
            assert!(!is_aksor_media_url(&Url::parse(url).unwrap()));
        }
    }

    #[test]
    fn retries_transport_and_access_failures_but_does_not_retry_missing_content() {
        for error in [
            "Kodik · страница плеера. Источник вернул HTTP 500.",
            "Alloha · Источник вернул HTTP 403.",
            "CVH · Источник вернул HTTP 451.",
            "Aksor · видеопоток недоступен (HTTP 503).",
            "Aksor · список потоков. Нет связи с источником.",
            "Источник не ответил вовремя.",
        ] {
            assert!(should_retry_with_proxy(error), "{error}");
        }
        assert!(!should_retry_with_proxy("Источник вернул HTTP 404."));
        assert!(!should_retry_with_proxy("Некорректный ответ Kodik."));
    }

    #[test]
    fn recognizes_the_actual_jam_cdn_studio_alias() {
        assert_eq!(voice_key("Озвучка JAM"), voice_key("Jam Club"));
        assert_ne!(voice_key("JAM"), voice_key("SHIZA Project"));
        assert_eq!(
            alloha_voice("(Russian) МС Entertainment"),
            voice_key("Озвучка MC Entertainment")
        );
    }

    pub struct MockUpstream {
        replies: Mutex<VecDeque<String>>,
        pub requests: Mutex<Vec<(String, Request)>>,
    }

    impl MockUpstream {
        pub fn new(replies: Vec<String>) -> Self {
            Self {
                replies: Mutex::new(replies.into()),
                requests: Mutex::default(),
            }
        }
    }

    impl Upstream for MockUpstream {
        async fn text(&self, url: &str, request: Request) -> Result<String> {
            self.requests.lock().unwrap().push((url.into(), request));
            self.replies
                .lock()
                .unwrap()
                .pop_front()
                .ok_or("Unexpected upstream request".into())
        }
    }

    pub fn candidate(url: &str, voice: &str) -> Candidate {
        Candidate {
            url: url.into(),
            video_id: 42,
            dubbing: voice.into(),
            episode: "1".into(),
        }
    }

    #[tokio::test]
    async fn rejects_untrusted_hosts_before_network_access() {
        let upstream = MockUpstream::new(vec![]);
        for url in [
            "http://player.aksor.tv/video/id",
            "https://127.0.0.1",
            "https://kodikplayer.com.evil.example",
            "https://user:pass@kodikplayer.com/video",
            "https://kodikplayer.com:8443/video",
            "https://ru.yummyani.me/profile",
        ] {
            assert!(resolve(&candidate(url, "Studio"), &upstream).await.is_err());
        }
        assert!(upstream.requests.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn aksor_streams_and_markers() {
        let upstream = MockUpstream::new(vec![json!({"duration":1400,"opening_start":15,"opening_length":90,"ending_start":1200,"ending_length":90,"qualities":{"q360":"https://cdn.example/360.mpd","q1080":"https://cdn.example/1080.mpd"}}).to_string()]);
        let result = resolve(
            &candidate("https://player.aksor.tv/video/public-id", "AniLibria"),
            &upstream,
        )
        .await
        .unwrap();
        assert_eq!(result["provider"], "Aksor");
        assert_eq!(result["videoId"], 42);
        assert_eq!(
            result["streams"][0],
            json!({"quality":360,"type":"dash","url":"https://cdn.example/360.mpd"})
        );
        assert_eq!(
            result["skips"]["opening"],
            json!({"time":15.0,"length":90.0})
        );
        assert_eq!(
            upstream.requests.lock().unwrap()[0].0,
            "https://player.aksor.tv/api/video/public-id"
        );
    }

    #[tokio::test]
    async fn kodik_decoding_metadata_and_skip_buttons() {
        let raw = "//cloud2.solodcdn.com/video/360.mp4:hls:manifest.m3u8";
        let encoded: String = STANDARD
            .encode(raw)
            .bytes()
            .map(|c| {
                if c.is_ascii_alphabetic() {
                    let base = if c.is_ascii_uppercase() { b'A' } else { b'a' };
                    ((c - base + 8) % 26 + base) as char
                } else {
                    c as char
                }
            })
            .collect();
        assert_eq!(decode_kodik(&encoded).unwrap(), format!("https:{raw}"));
        assert_eq!(
            decode_kodik(encoded.trim_end_matches('=')).unwrap(),
            format!("https:{raw}")
        );
        assert_eq!(
            decode_kodik(&format!(" \n{}\t", encoded.trim_end_matches('='))).unwrap(),
            format!("https:{raw}")
        );
        let html = r#"var domain="kodikplayer.com";var d_sign='signature';var pd="kodikplayer.com";var pd_sign='p';var ref="";var ref_sign='r';vInfo.type='seria';vInfo.id='123';vInfo.hash='abc';parseSkipButton("0:00-1:30,21:05-22:35", "anime")"#;
        let upstream = MockUpstream::new(vec![
            html.into(),
            json!({"links":{"360":[{"src":encoded}]},"advert_script":"<script/>"}).to_string(),
        ]);
        let result = resolve(
            &candidate("https://kodikplayer.com/seria/123/hash", "Studio"),
            &upstream,
        )
        .await
        .unwrap();
        assert_eq!(result["streams"][0]["type"], "hls");
        assert_eq!(
            result["streams"][0]["url"],
            "https://cloud2.solodcdn.com/video/360.mp4:hls:manifest.m3u8"
        );
        assert_eq!(
            result["streams"][0]["fallback"],
            json!({"type":"mp4", "url":"https://cloud2.solodcdn.com/video/360.mp4"})
        );
        assert_eq!(result["skips"]["ending"]["time"], 1265.0);
        let requests = upstream.requests.lock().unwrap();
        assert_eq!(requests[1].0, "https://kodikplayer.com/ftor");
        assert_eq!(requests[1].1.form.as_ref().unwrap()["d_sign"], "signature");
        assert!(kodik_fields("<script>throw new Error()</script>").is_err());
    }

    #[tokio::test]
    async fn cvh_keeps_episode_voice_and_subtitles_separate() {
        let upstream = MockUpstream::new(vec![json!({"items":[{"episode":1,"voiceStudio":"AniLiberty","voiceType":"Субтитры","vkId":1},{"episode":1,"voiceStudio":"AniLiberty","voiceType":"Озвучка","vkId":2},{"episode":2,"voiceStudio":"AniLibria","vkId":3}]}).to_string(), json!({"duration":1400,"sources":{"mpegLowUrl":"https://cdn.example/video.mp4"}}).to_string()]);
        let result = resolve(
            &candidate(
                "https://ru.yummyani.me/iframeCVH.html?anime_id=10531&episode=1",
                "Озвучка AniLibria",
            ),
            &upstream,
        )
        .await
        .unwrap();
        assert_eq!(result["provider"], "CVH");
        assert_eq!(result["streams"][0]["quality"], 360);
        assert_eq!(
            upstream.requests.lock().unwrap()[1].0,
            "https://plapi.cdnvideohub.com/api/v1/player/sv/video/2"
        );
    }
    #[tokio::test]
    async fn cvh_films_match_voice_without_an_episode_field() {
        let upstream=MockUpstream::new(vec![json!({"isSerial":false,"items":[{"vkId":"1","voiceType":"Дубляж"},{"vkId":"2","voiceStudio":"2x2","voiceType":"Многоголосый"}]}).to_string(),json!({"duration":7472,"sources":{"mpegLowUrl":"https://cdn.example/movie.mp4"}}).to_string()]);
        let result = resolve(
            &candidate(
                "https://ru.yummyani.me/iframeCVH.html?anime_id=199&episode=1",
                "Озвучка 2x2",
            ),
            &upstream,
        )
        .await
        .unwrap();
        assert_eq!(result["duration"].as_f64(), Some(7472.0));
        assert!(upstream.requests.lock().unwrap()[1].0.ends_with("/video/2"));
    }
    #[tokio::test]
    async fn cvh_anilibria_dub_is_not_the_older_voice_over() {
        for (label, code, id) in [
            ("Дубляж AniLibria", "AniLiberty", "1"),
            ("Озвучка AniLibria", "AniLibria", "2"),
        ] {
            let upstream=MockUpstream::new(vec![json!({"isSerial":true,"items":[{"episode":1,"voiceStudio":"AniLiberty","voiceType":"Дубляж","vkId":"1"},{"episode":1,"voiceStudio":"AniLibria","voiceType":"Многоголосый","vkId":"2"}]}).to_string(),json!({"sources":{"mpegLowUrl":"https://cdn.example/video.mp4"}}).to_string()]);
            resolve(&candidate(&format!("https://ru.yummyani.me/iframeCVH.html?anime_id=2904&episode=1&dubbing_code={code}"),label),&upstream).await.unwrap();
            assert!(upstream.requests.lock().unwrap()[1]
                .0
                .ends_with(&format!("/video/{id}")));
        }
    }
    #[tokio::test]
    async fn cvh_missing_episode_never_matches_a_serial_or_second_film_episode() {
        for (serial, episode) in [(true, "1"), (false, "2")] {
            let upstream = MockUpstream::new(vec![
                json!({"isSerial":serial,"items":[{"vkId":"2","voiceStudio":"2x2"}]}).to_string(),
            ]);
            let mut selected = candidate(
                "https://ru.yummyani.me/iframeCVH.html?anime_id=199",
                "Озвучка 2x2",
            );
            selected.episode = episode.into();
            assert!(resolve(&selected, &upstream).await.is_err());
            assert_eq!(upstream.requests.lock().unwrap().len(), 1);
        }
    }
}

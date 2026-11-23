use regex::Regex;
use reqwest::Client;
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap},
    sync::Arc,
    time::{Duration, Instant},
};
use tauri::http::{HeaderMap, Method, Response, StatusCode};
use tokio::sync::Mutex;
use url::Url;

use crate::{
    providers::{alloha_voice, limited_body, request, Candidate, Result, Upstream},
    skips::provider_skips,
};

pub fn token() -> String {
    (0..16)
        .map(|_| format!("{:02x}", rand::random::<u8>()))
        .collect()
}

#[derive(Clone)]
pub struct Session {
    id: String,
    created: Instant,
    used: Instant,
    roots: Vec<Url>,
    resources: HashMap<String, Url>,
    reverse: HashMap<String, String>,
    headers: HeaderMap,
}

pub type Sessions = Arc<Mutex<HashMap<String, Session>>>;

#[cfg(desktop)]
pub async fn resource_url(sessions: &Sessions, session: &str, resource: &str) -> Option<Url> {
    sessions
        .lock()
        .await
        .get(session)?
        .resources
        .get(resource)
        .cloned()
}

impl Session {
    fn expired(&self) -> bool {
        self.used.elapsed() > Duration::from_secs(180)
            || self.created.elapsed() > Duration::from_secs(2700)
    }

    fn register(&mut self, raw: &str) -> Result<String> {
        let url = media_url(raw)?;
        if !self
            .roots
            .iter()
            .any(|root| root.origin() == url.origin() && url.path().starts_with(root.path()))
        {
            return Err("Alloha вернул адрес за пределами серии.".into());
        }
        if let Some(id) = self.reverse.get(url.as_str()) {
            return Ok(format!("alloha/{}/{id}", self.id));
        }
        if self.resources.len() >= 4096 {
            return Err("Слишком большой плейлист Alloha.".into());
        }
        let id = token();
        self.reverse.insert(url.to_string(), id.clone());
        self.resources.insert(id.clone(), url);
        Ok(format!("alloha/{}/{id}", self.id))
    }
}

fn media_url(raw: &str) -> Result<Url> {
    let url = Url::parse(raw).map_err(|_| "Неизвестный CDN Alloha.".to_string())?;
    if url.scheme() != "https"
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || !Regex::new(r"^[a-z0-9-]+\.userplay\.live$")
            .unwrap()
            .is_match(url.host_str().unwrap_or(""))
    {
        return Err("Неизвестный CDN Alloha.".into());
    }
    Ok(url)
}

pub fn bootstrap(html: &str) -> Result<(String, String, String, String)> {
    let capture = |pattern: &str| -> Result<String> {
        Regex::new(pattern)
            .unwrap()
            .captures(html)
            .map(|c| c[1].to_string())
            .ok_or("Формат страницы Alloha изменился.".into())
    };
    let nonce = capture(r#"<meta\s+name="viewporti"\s+content="([A-Za-z0-9_-]{2,512})""#)?;
    let text = capture(r"const\s+fileList\s*=\s*JSON\.parse\('([^\n]*?)'\);")?;
    let script = capture(r#"src="(/build/app\.[a-f0-9]+\.js)""#)?;
    let list: Value = serde_json::from_str(&text.replace("\\'", "'"))
        .map_err(|_| "Формат страницы Alloha изменился.")?;
    let id = list["active"]["id"]
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| list["active"]["id"].to_string());
    if id.is_empty() || !id.bytes().all(|c| c.is_ascii_digit()) {
        return Err("Alloha не предоставил выбранную серию.".into());
    }
    Ok((
        nonce,
        id,
        script,
        list["active"]["translation"].as_str().unwrap_or("").into(),
    ))
}

fn regroup(text: &[u8], group: impl Fn(usize) -> usize, descending: bool) -> Vec<u8> {
    let count = text.len().next_power_of_two().ilog2() as usize + 1;
    let mut buckets = vec![Vec::new(); count];
    let mut sizes = vec![0; count];
    for i in 0..text.len() {
        sizes[group(i)] += 1;
    }
    let mut start = 0;
    for k in 0..count {
        let g = if descending { count - 1 - k } else { k };
        buckets[g].extend_from_slice(&text[start..start + sizes[g]]);
        start += sizes[g];
    }
    let mut positions = vec![0; count];
    (0..text.len())
        .map(|i| {
            let g = group(i);
            let value = buckets[g][positions[g]];
            positions[g] += 1;
            value
        })
        .collect()
}

pub fn nonce(text: &str) -> String {
    let first = regroup(
        text.as_bytes(),
        |i| if i == 0 { 0 } else { i.ilog2() as usize + 1 },
        true,
    );
    let second = regroup(
        &first,
        |i| {
            if i == 0 {
                first.len().next_power_of_two().ilog2() as usize
            } else {
                i.trailing_zeros() as usize
            }
        },
        false,
    );
    let prime = |n: usize| {
        (2..)
            .take_while(|i| i * i <= n)
            .all(|i| !n.is_multiple_of(i))
    };
    let mut size = second.len() + 1;
    while !prime(size) {
        size += 1;
    }
    let mut result = vec![0; second.len()];
    let mut index = 0;
    for c in second {
        loop {
            index = (index + 2) % size;
            if index < result.len() && result[index] == 0 {
                break;
            }
        }
        result[index] = c;
    }
    String::from_utf8(result).unwrap()
}

#[derive(Clone)]
pub struct Pending {
    result: Value,
    session: Session,
}

impl Pending {
    pub fn result(&self) -> &Value {
        &self.result
    }
}

#[cfg(test)]
pub async fn resolve(
    url: &Url,
    candidate: &Candidate,
    upstream: &impl Upstream,
    sessions: &Sessions,
) -> Result<Value> {
    let pending = prepare(url, candidate, upstream).await?;

    Ok(commit(pending, sessions).await)
}

// Resolver races can drop a pending value without leaving a registered session.
pub async fn prepare(
    url: &Url,
    candidate: &Candidate,
    upstream: &impl Upstream,
) -> Result<Pending> {
    let html = upstream
        .text(
            url.as_str(),
            request(&[("Referer", "https://ru.yummyani.me/")], None)?,
        )
        .await?;
    let (raw_nonce, id, script, translation) = bootstrap(&html)?;
    let fingerprint = format!("{}{}", token(), token());
    let origin = url.origin().ascii_serialization();
    let query: BTreeMap<_, _> = url.query_pairs().into_owned().collect();
    let form = BTreeMap::from([
        (
            "token".into(),
            query.get("token").cloned().unwrap_or_default(),
        ),
        ("av1".into(), "false".into()),
        ("autoplay".into(), "0".into()),
        ("audio".into(), String::new()),
        ("subtitle".into(), String::new()),
    ]);
    let data: Value = serde_json::from_str(
        &upstream
            .text(
                &format!("{origin}/bnsi/movies/{id}"),
                request(
                    &[
                        ("Origin", &origin),
                        ("Referer", url.as_str()),
                        ("X-Requested-With", "XMLHttpRequest"),
                        ("Borth", &format!("{fingerprint}|{}", nonce(&raw_nonce))),
                    ],
                    Some(form),
                )?,
            )
            .await?,
    )
    .map_err(|_| "Некорректный ответ Alloha.")?;
    let subtitles = candidate.dubbing.to_lowercase().contains("субтитры");
    let voice = data["hlsSource"]
        .as_array()
        .and_then(|values| {
            values.iter().find(|v| {
                let label = v["label"].as_str().unwrap_or("");
                if subtitles {
                    v["default"].as_bool() == Some(true)
                        && label.to_lowercase().starts_with("(japanese)")
                } else {
                    alloha_voice(label) == alloha_voice(&candidate.dubbing)
                }
            })
        })
        .or_else(|| {
            let sources = data["hlsSource"].as_array()?;
            // Accept anonymous audio only when the selected bootstrap confirms
            // the exact studio, never as a substitute for an unrelated dub.
            (!subtitles
                && !translation.is_empty()
                && alloha_voice(&translation) == alloha_voice(&candidate.dubbing)
                && sources.len() == 1
                && Regex::new(r"(?i)^\((?:Undetermined|Russian)\)\s*\d+$")
                    .unwrap()
                    .is_match(sources[0]["label"].as_str().unwrap_or("")))
            .then_some(&sources[0])
        })
        .ok_or("Alloha не предоставил эту озвучку или субтитры для нашего плеера.")?;
    let caption = data["tracks"].as_array().and_then(|values| {
        values.iter().find(|track| {
            track["default"].as_bool() == Some(true)
                && track["kind"] == "captions"
                && track["src"].is_string()
        })
    });
    if subtitles && caption.is_none() {
        return Err("Alloha не предоставил субтитры для нашего плеера.".into());
    }
    let script = upstream
        .text(
            &format!("{origin}{script}"),
            request(&[("Referer", url.as_str())], None)?,
        )
        .await?;
    let pattern = Regex::new(r#"['"]([A-Za-z0-9]{300,1200})['"]"#).unwrap();
    let guards: Vec<_> = pattern.captures_iter(&script).collect();
    if guards.len() != 1 {
        return Err("Формат сессии Alloha изменился.".into());
    }
    let headers = request(
        &[
            ("User-Agent", "Mozilla/5.0"),
            ("Origin", &origin),
            ("Referer", url.as_str()),
            ("Accepts-Controls", &fingerprint),
            ("Authorizations", &format!("Bearer {}", &guards[0][1])),
        ],
        None,
    )?
    .headers;
    let mut streams = Vec::new();
    if let Some(qualities) = voice["quality"].as_object() {
        for (quality, raw) in qualities {
            if let (Ok(quality), Some(raw)) = (quality.parse::<u32>(), raw.as_str()) {
                if quality > 0 {
                    streams.push((quality, media_url(raw)?));
                }
            }
        }
    }
    if streams.is_empty() {
        return Err("Alloha не предоставил видео.".into());
    }
    let mut roots: Vec<_> = streams
        .iter()
        .map(|(_, url)| url.join("./").unwrap())
        .collect();
    if let Some(caption) = caption {
        roots.push(
            media_url(caption["src"].as_str().unwrap())?
                .join("./")
                .unwrap(),
        );
    }
    let mut session = Session {
        id: token(),
        created: Instant::now(),
        used: Instant::now(),
        roots,
        resources: HashMap::new(),
        reverse: HashMap::new(),
        headers,
    };
    let streams: Vec<_> = streams.iter().map(|(quality, url)| Ok(json!({"quality": quality,"type":"hls","sourceHost":url.host_str(),"url":session.register(url.as_str())?}))).collect::<Result<_>>()?;
    let mut result = json!({"provider":"Alloha","duration":0,"relay":true,"videoId":candidate.video_id,"skips":provider_skips(&data, &html),"streams":streams});
    if let Some(caption) = caption {
        result["caption"] = json!({"url":session.register(caption["src"].as_str().unwrap())?,"label":caption["label"],"language":"ru"});
    }
    Ok(Pending { result, session })
}

pub async fn commit(pending: Pending, sessions: &Sessions) -> Value {
    let Pending { result, session } = pending;
    let mut sessions = sessions.lock().await;
    sessions.retain(|_, session| !session.expired());
    if let Some(registered) = sessions.get_mut(&session.id) {
        registered.used = Instant::now();
        return result;
    }
    if sessions.len() >= 8 {
        if let Some(oldest) = sessions
            .iter()
            .min_by_key(|(_, s)| s.created)
            .map(|(id, _)| id.clone())
        {
            sessions.remove(&oldest);
        }
    }
    sessions.insert(session.id.clone(), session);
    result
}

pub fn rewrite_playlist(
    text: &str,
    base: &Url,
    mut register: impl FnMut(&str) -> Result<String>,
) -> Result<String> {
    if !text.starts_with("#EXTM3U") || text.len() > 512000 {
        return Err("Некорректный плейлист Alloha.".into());
    }
    let pattern = Regex::new(r#"URI="([^"]+)""#).unwrap();
    text.split('\n')
        .map(|line| {
            let line = line.trim_end_matches('\r');
            if line.starts_with('#') {
                let mut result = String::new();
                let mut offset = 0;
                for captures in pattern.captures_iter(line) {
                    let whole = captures.get(0).unwrap();
                    result.push_str(&line[offset..whole.start()]);
                    result.push_str(&format!(
                        "URI=\"{}\"",
                        register(
                            base.join(&captures[1])
                                .map_err(|_| "Некорректный адрес сегмента.")?
                                .as_str()
                        )?
                    ));
                    offset = whole.end();
                }
                result.push_str(&line[offset..]);
                Ok(result)
            } else if line.trim().is_empty() {
                Ok(line.into())
            } else {
                register(
                    base.join(line.trim())
                        .map_err(|_| "Некорректный адрес сегмента.")?
                        .as_str(),
                )
            }
        })
        .collect::<Result<Vec<_>>>()
        .map(|lines| lines.join("\n"))
}

pub async fn relay(
    client: &Client,
    sessions: &Sessions,
    session_id: &str,
    resource_id: &str,
    method: Method,
    incoming: HeaderMap,
) -> Result<Response<Vec<u8>>> {
    let (url, mut headers) = {
        let mut sessions = sessions.lock().await;
        let session = sessions
            .get_mut(session_id)
            .filter(|s| !s.expired())
            .ok_or("Сессия просмотра истекла.")?;
        let url = session
            .resources
            .get(resource_id)
            .ok_or("Неизвестный сегмент.")?
            .clone();
        session.used = Instant::now();
        (url, session.headers.clone())
    };
    if let Some(range) = incoming.get("range").filter(|r| {
        r.to_str()
            .is_ok_and(|r| Regex::new(r"^bytes=\d*-\d*$").unwrap().is_match(r))
    }) {
        if !url.path().to_lowercase().ends_with(".m3u8") {
            headers.insert("range", range.clone());
            if let Some(validator) = incoming.get("if-range") {
                headers.insert("if-range", validator.clone());
            }
        }
    }
    let response = client
        .request(method.clone(), url.clone())
        .headers(headers)
        .timeout(Duration::from_secs(25))
        .send()
        .await
        .map_err(|_| "Нет связи с Alloha.")?;
    if !response.status().is_success() {
        return Ok(Response::builder()
            .status(response.status())
            .body(Vec::new())
            .unwrap());
    }
    let playlist = response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.to_lowercase().contains("mpegurl"))
        || url.path().to_lowercase().ends_with(".m3u8");
    if playlist && method == Method::GET {
        let bytes = limited_body(response, 512000).await?;
        #[cfg(desktop)]
        let revision = crate::downloads::manifest_digest(&bytes);
        let text = std::str::from_utf8(&bytes).map_err(|_| "Некорректный плейлист Alloha.")?;
        let mut sessions = sessions.lock().await;
        let session = sessions
            .get_mut(session_id)
            .ok_or("Сессия просмотра истекла.")?;
        let rewritten = rewrite_playlist(text, &url, |raw| {
            session
                .register(raw)
                .map(|path| path.rsplit('/').next().unwrap().into())
        })?;
        let response = Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "application/vnd.apple.mpegurl");
        #[cfg(desktop)]
        let response = response.header(crate::downloads::MANIFEST_ID, revision);
        Ok(response.body(rewritten.into_bytes()).unwrap())
    } else {
        let mut builder = Response::builder().status(response.status());
        for key in [
            "content-type",
            "content-length",
            "content-range",
            "accept-ranges",
            "etag",
        ] {
            if let Some(value) = response.headers().get(key) {
                builder = builder.header(key, value);
            }
        }
        let body = if method == Method::HEAD {
            Vec::new()
        } else {
            limited_body(response, 32 * 1024 * 1024).await?
        };
        Ok(builder.body(body).unwrap())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::tests::{candidate, MockUpstream};

    #[tokio::test]
    async fn anonymous_audio_requires_bootstrap_studio_confirmation() {
        let url = Url::parse("https://alloha.yani.tv/?translation=167").unwrap();
        for (voice, translation, label) in [
            ("Озвучка SHIZA Project", "SHIZA Project", "(Undetermined) 1"),
            ("Озвучка JAM", "Jam Club", "(Russian) 1"),
            ("Other", "SHIZA Project", "(Undetermined) 1"),
        ] {
            let upstream=MockUpstream::new(vec![r#"<meta name="viewporti" content="abcdefgh"><script src="/build/app.123abc.js"></script><script>const fileList = JSON.parse('{"active":{"id":123,"translation":"SHIZA Project"}}');</script>"#.replace("SHIZA Project",translation),json!({"hlsSource":[{"label":label,"quality":{"360":"https://edge.userplay.live/series/master.m3u8"}}]}).to_string(),format!("return '{}'","A".repeat(380))]);
            let result = resolve(
                &url,
                &candidate(url.as_str(), voice),
                &upstream,
                &Sessions::default(),
            )
            .await;
            if voice == "Other" {
                assert!(result.is_err());
            } else {
                assert_eq!(result.unwrap()["provider"], "Alloha");
            }
        }
    }

    fn upstream(data: Value) -> MockUpstream {
        MockUpstream::new(vec![r#"<meta name="viewporti" content="abcdefgh"><script src="/build/app.123abc.js"></script><script>const fileList = JSON.parse('{"active":{"id":123}}');</script>"#.into(), data.to_string(), format!("return '{}'", "A".repeat(380))])
    }

    #[tokio::test]
    async fn keeps_session_headers_private_and_matches_dubbing() {
        let upstream = upstream(
            json!({"hlsSource":[{"label":"(Russian) Dub - Арт-Дубляж","quality":{"360":"https://edge.userplay.live/series/master.m3u8"}}],"skipTime":"0-90,1265-1371"}),
        );
        let sessions = Sessions::default();
        let url = Url::parse("https://alloha.yani.tv/?token=public").unwrap();
        let result = resolve(
            &url,
            &candidate(url.as_str(), "Арт-Дубляж"),
            &upstream,
            &sessions,
        )
        .await
        .unwrap();
        assert_eq!(result["provider"], "Alloha");
        assert_eq!(result["relay"], true);
        assert_eq!(result["streams"][0]["sourceHost"], "edge.userplay.live");
        assert!(result["streams"][0]["url"]
            .as_str()
            .unwrap()
            .starts_with("alloha/"));
        assert!(!result.to_string().contains("AAAA"));
        assert!(!result.to_string().contains("/series/master.m3u8"));
        assert_eq!(result["skips"]["ending"]["length"], 106.0);
        let sessions = sessions.lock().await;
        let session = sessions.values().next().unwrap();
        assert!(session.headers["authorizations"]
            .to_str()
            .unwrap()
            .starts_with("Bearer AAAA"));
        assert_eq!(session.headers["origin"], "https://alloha.yani.tv");
        assert!(upstream.requests.lock().unwrap()[1].1.headers["borth"]
            .to_str()
            .unwrap()
            .ends_with("|fgdcheab"));
    }

    #[tokio::test]
    async fn subtitles_require_original_audio_and_full_captions() {
        let url = Url::parse("https://alloha.yani.tv/?token=public").unwrap();
        let data = json!({"hlsSource":[{"label":"(Japanese) 7","default":true,"quality":{"360":"https://edge.userplay.live/series/master.m3u8"}}],"tracks":[{"kind":"captions","label":"Russian full","default":true,"src":"https://edge.userplay.live/subs/full.vtt"}]});
        let result = resolve(
            &url,
            &candidate(url.as_str(), "Субтитры"),
            &upstream(data.clone()),
            &Sessions::default(),
        )
        .await
        .unwrap();
        assert_eq!(result["caption"]["label"], "Russian full");
        assert!(resolve(
            &url,
            &candidate(url.as_str(), "Другая студия"),
            &upstream(data),
            &Sessions::default()
        )
        .await
        .is_err());
        let data = json!({"hlsSource":[{"label":"(Japanese) 7","default":true,"quality":{"360":"https://edge.userplay.live/series/master.m3u8"}}]});
        assert!(resolve(
            &url,
            &candidate(url.as_str(), "Субтитры"),
            &upstream(data),
            &Sessions::default()
        )
        .await
        .is_err());
        let data = json!({"hlsSource":[{"label":"(Russian) AniLibria","quality":{"360":"https://127.0.0.1/secret"}}]});
        assert!(resolve(
            &url,
            &candidate(url.as_str(), "AniLibria"),
            &upstream(data),
            &Sessions::default()
        )
        .await
        .is_err());
    }

    #[test]
    fn bootstrap_nonce_and_untrusted_scripts() {
        let html = r#"<meta name="viewporti" content="abcdefgh"><script src="/build/app.123abc.js"></script><script>const fileList = JSON.parse('{"active":{"id":123}}');</script>"#;
        assert_eq!(
            bootstrap(html).unwrap(),
            (
                "abcdefgh".into(),
                "123".into(),
                "/build/app.123abc.js".into(),
                String::new()
            )
        );
        assert_eq!(nonce("abcdefgh"), "fgdcheab");
        assert!(bootstrap("<script>throw new Error()</script>").is_err());
        assert!(bootstrap(&html.replace("123}", "\"../../private\"}")).is_err());
    }

    #[test]
    fn rewrites_every_hls_resource_and_rejects_foreign_roots() {
        let mut session = Session {
            id: token(),
            created: Instant::now(),
            used: Instant::now(),
            roots: vec![Url::parse("https://edge.userplay.live/series/").unwrap()],
            resources: HashMap::new(),
            reverse: HashMap::new(),
            headers: HeaderMap::new(),
        };
        let base = Url::parse("https://edge.userplay.live/series/master.m3u8").unwrap();
        let text = "#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"\n#EXTINF:4,\nseg.m4s\n";
        let result = rewrite_playlist(text, &base, |raw| session.register(raw)).unwrap();
        assert_eq!(session.resources.len(), 3);
        assert!(!result.contains("userplay.live"));
        assert!(result.contains("URI=\"alloha/"));
        assert!(session.register("https://127.0.0.1/private").is_err());
        assert!(session
            .register("https://edge.userplay.live/other/seg.ts")
            .is_err());
        assert!(
            rewrite_playlist("#EXTM3U\n../other/seg.ts", &base, |raw| session
                .register(raw))
            .is_err()
        );
        assert!(rewrite_playlist("<html/>", &base, |raw| session.register(raw)).is_err());
    }
}

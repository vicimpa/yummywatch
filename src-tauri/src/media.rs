//! Bounded transport for registered provider media resources.
use crate::{
    alloha::token,
    providers::{limited_body, send_with_server_retry, Result},
};
use reqwest::Client;
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};
use tauri::http::{HeaderMap, Method, Response};
use tokio::sync::Mutex;
use url::Url;

const CHUNK: u64 = 8 * 1024 * 1024;

#[derive(Clone, Copy)]
enum Cdn {
    Cvh,
    #[cfg(desktop)]
    Kodik,
    #[cfg(desktop)]
    Aksor,
    #[cfg(any(desktop, target_os = "android"))]
    AksorHls,
}

impl Cdn {
    fn allows(self, host: &str) -> bool {
        match self {
            Self::Cvh => [".okcdn.ru", ".mycdn.me", ".vkuser.net"]
                .iter()
                .any(|suffix| host.ends_with(suffix)),
            #[cfg(desktop)]
            Self::Kodik => host == "solodcdn.com" || host.ends_with(".solodcdn.com"),
            #[cfg(desktop)]
            Self::Aksor => host.ends_with(".aksor.tv"),
            #[cfg(any(desktop, target_os = "android"))]
            Self::AksorHls => host == "old.tut-video.net" || host.ends_with(".aksor.tv"),
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Cvh => "CVH",
            #[cfg(desktop)]
            Self::Kodik => "Kodik",
            #[cfg(desktop)]
            Self::Aksor => "Aksor",
            #[cfg(any(desktop, target_os = "android"))]
            Self::AksorHls => "Aksor",
        }
    }
}

struct Session {
    used: Instant,
    cdn: Cdn,
    resources: HashMap<String, Url>,
    roots: Vec<Url>,
    #[cfg(desktop)]
    resolution: Option<(Value, Value)>,
    #[cfg(any(desktop, target_os = "android"))]
    hls_playlists: HashMap<String, String>,
    #[cfg(any(desktop, target_os = "android"))]
    aksor_proxy: Option<Client>,
}
impl Session {
    fn register(&mut self, url: Url) -> Result<String> {
        if !self
            .roots
            .iter()
            .any(|root| root.origin() == url.origin() && url.path().starts_with(root.path()))
        {
            return Err(format!(
                "{} вернул адрес за пределами потока.",
                self.cdn.label()
            ));
        }
        if let Some((id, _)) = self.resources.iter().find(|(_, value)| **value == url) {
            return Ok(id.clone());
        }
        if self.resources.len() >= 8192 {
            return Err(format!("Слишком большой плейлист {}.", self.cdn.label()));
        }
        let id = token();
        self.resources.insert(id.clone(), url);
        Ok(id)
    }
}
#[derive(Clone, Default)]
pub struct Media {
    sessions: Arc<Mutex<HashMap<String, Session>>>,
    #[cfg(desktop)]
    aksor: Arc<tokio::sync::OnceCell<Client>>,
}

fn media_url(cdn: Cdn, raw: &str) -> Result<Url> {
    let provider = cdn.label();
    let url = Url::parse(raw).map_err(|_| format!("Некорректный адрес {provider}."))?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || !url.host_str().is_some_and(|host| cdn.allows(host))
    {
        return Err(format!("Неизвестный CDN {provider}."));
    }
    Ok(url)
}

#[cfg(desktop)]
pub fn direct_media_supported(provider: &str, raw: &str) -> bool {
    let cdn = match provider {
        "Kodik" => Cdn::Kodik,
        "Aksor" => Cdn::Aksor,
        _ => return false,
    };
    media_url(cdn, raw).is_ok()
}

fn register_stream(session: &mut Session, id: &str, stream: &mut Value) -> Result<()> {
    let provider = session.cdn.label();
    let raw = stream["url"]
        .as_str()
        .ok_or_else(|| format!("Нет адреса {provider}."))?;
    let url = media_url(session.cdn, raw)?;
    session.roots.push(
        url.join("./")
            .map_err(|_| format!("Некорректный поток {provider}."))?,
    );
    let part = session.register(url.clone())?;
    #[cfg(desktop)]
    if !matches!(session.cdn, Cdn::Cvh) {
        stream["legacyUrl"] = raw.into();
    }
    stream["sourceHost"] = url.host_str().unwrap().into();
    stream["url"] = format!("media/{id}/{part}").into();
    Ok(())
}

fn bounded_range(raw: Option<&str>) -> Result<String> {
    let raw = raw
        .unwrap_or("bytes=0-")
        .strip_prefix("bytes=")
        .ok_or("Некорректный Range.")?;
    let (start, end) = raw.split_once('-').ok_or("Некорректный Range.")?;
    if start.is_empty() {
        let size = end
            .parse::<u64>()
            .ok()
            .filter(|size| *size > 0)
            .ok_or("Некорректный Range.")?;
        return Ok(format!("bytes=-{}", size.min(CHUNK)));
    }
    let start = start.parse::<u64>().map_err(|_| "Некорректный Range.")?;
    let limit = start.checked_add(CHUNK - 1).ok_or("Некорректный Range.")?;
    let end = if end.is_empty() {
        limit
    } else {
        end.parse::<u64>()
            .map_err(|_| "Некорректный Range.")?
            .min(limit)
    };
    if end < start {
        return Err("Некорректный Range.".into());
    }
    Ok(format!("bytes={start}-{end}"))
}

impl Media {
    #[cfg(desktop)]
    pub async fn resource_url(&self, session: &str, resource: &str) -> Option<Url> {
        self.sessions
            .lock()
            .await
            .get(session)?
            .resources
            .get(resource)
            .cloned()
    }

    pub async fn register(&self, mut result: Value) -> Result<Value> {
        let cdn = match result["provider"].as_str() {
            #[cfg(desktop)]
            Some("Kodik") => Cdn::Kodik,
            #[cfg(desktop)]
            Some("Aksor") => Cdn::Aksor,
            _ => Cdn::Cvh,
        };
        #[cfg(desktop)]
        let source = result["videoId"].is_u64().then(|| result.clone());
        let mut sessions = self.sessions.lock().await;
        sessions.retain(|_, session| session.used.elapsed() < Duration::from_secs(180));
        #[cfg(desktop)]
        if let Some(past) = source.as_ref().and_then(|source| {
            sessions.values_mut().find(|session| {
                session
                    .resolution
                    .as_ref()
                    .is_some_and(|(previous, _)| previous == source)
            })
        }) {
            past.used = Instant::now();
            return Ok(past.resolution.as_ref().unwrap().1.clone());
        }
        let id = token();
        let mut session = Session {
            used: Instant::now(),
            cdn,
            resources: HashMap::new(),
            roots: Vec::new(),
            #[cfg(desktop)]
            resolution: None,
            #[cfg(any(desktop, target_os = "android"))]
            hls_playlists: HashMap::new(),
            #[cfg(any(desktop, target_os = "android"))]
            aksor_proxy: None,
        };
        for stream in result["streams"]
            .as_array_mut()
            .ok_or_else(|| format!("Нет потоков {}.", cdn.label()))?
        {
            #[cfg(desktop)]
            if !matches!(cdn, Cdn::Cvh) {
                // Some assets may use a CDN we only know how to play directly.
                // Keep those URLs for playback, outside the download transport.
                let _ = register_stream(&mut session, &id, stream);
                if stream["fallback"].is_object() {
                    let _ = register_stream(&mut session, &id, &mut stream["fallback"]);
                }
                continue;
            }
            register_stream(&mut session, &id, stream)?;
        }
        #[cfg(desktop)]
        if let Some(reserves) = result["downloadMp4"].as_array_mut() {
            reserves.retain_mut(|stream| register_stream(&mut session, &id, stream).is_ok());
        }
        if session.resources.is_empty() {
            return Ok(result);
        }
        if sessions.len() >= 8 {
            if let Some(oldest) = sessions
                .iter()
                .min_by_key(|(_, s)| s.used)
                .map(|(id, _)| id.clone())
            {
                sessions.remove(&oldest);
            }
        }
        result["relay"] = Value::Bool(true);
        #[cfg(desktop)]
        if let Some(source) = source {
            session.resolution = Some((source, result.clone()));
        }
        sessions.insert(id, session);
        Ok(result)
    }

    #[cfg(any(desktop, target_os = "android"))]
    pub async fn aksor_hls(&self, client: Client, mut url: Url, proxied: bool) -> Result<String> {
        use crate::{download_dash, providers::AKSOR_MEDIA_REFERER};
        use std::fmt::Write;

        for _ in 0..4 {
            url = media_url(Cdn::AksorHls, url.as_str())?;
            let response = client
                .get(url.clone())
                .header("Referer", AKSOR_MEDIA_REFERER)
                .timeout(Duration::from_secs(7))
                .send()
                .await
                .map_err(|_| "Нет связи с источником.")?;
            if response.status().is_redirection() {
                url = response
                    .headers()
                    .get("location")
                    .and_then(|location| location.to_str().ok())
                    .and_then(|location| url.join(location).ok())
                    .ok_or("Некорректный адрес DASH Aksor.")?;
                continue;
            }
            if response.status() == 203 {
                return Err("Aksor · нет манифеста DASH (HTTP 203).".into());
            }
            let bytes = limited_body(response, 512_000).await?;
            let text = std::str::from_utf8(&bytes).map_err(|_| "Некорректный DASH Aksor.")?;
            let id = token();
            let mut session = Session {
                used: Instant::now(),
                cdn: Cdn::AksorHls,
                resources: HashMap::new(),
                roots: vec![url
                    .join("./")
                    .map_err(|_| "Некорректный адрес DASH Aksor.")?],
                #[cfg(desktop)]
                resolution: None,
                hls_playlists: HashMap::new(),
                aksor_proxy: proxied.then_some(client),
            };
            let tracks = download_dash::hls_tracks(text, &url, |fragment| {
                let fragment = media_url(Cdn::AksorHls, fragment.as_str())?;
                Ok(format!("{}.m4s", session.register(fragment)?))
            })?;
            let mut master = String::from("#EXTM3U\n#EXT-X-VERSION:7\n");
            let (mut video, mut audio) = (String::new(), "");
            let mut bandwidth = 0u64;
            for track in tracks {
                bandwidth = bandwidth.saturating_add(track.bandwidth);
                let resource = token();
                if track.kind == "audio" {
                    audio = ",AUDIO=\"audio\"";
                    writeln!(master, "#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"audio\",NAME=\"Audio\",DEFAULT=YES,AUTOSELECT=YES,URI=\"{resource}.m3u8\"").unwrap();
                } else {
                    video = format!("{resource}.m3u8");
                }
                session.hls_playlists.insert(resource, track.playlist);
            }
            writeln!(
                master,
                "#EXT-X-STREAM-INF:BANDWIDTH={bandwidth}{audio}\n{video}"
            )
            .unwrap();
            let resource = token();
            session.hls_playlists.insert(resource.clone(), master);
            let mut sessions = self.sessions.lock().await;
            sessions.retain(|_, session| session.used.elapsed() < Duration::from_secs(180));
            sessions.insert(id.clone(), session);
            return Ok(format!("yumiwatch-media://localhost/media/{id}/{resource}"));
        }
        Err("Aksor · слишком много перенаправлений.".into())
    }

    #[cfg(desktop)]
    pub async fn dash_manifest(
        &self,
        upstream: &str,
        quality: u32,
        text: &str,
    ) -> Result<(String, Vec<(String, String)>)> {
        let (id, resource) = upstream
            .strip_prefix("/media/")
            .and_then(|path| path.split_once('/'))
            .ok_or("Неизвестный манифест DASH.")?;
        let mut sessions = self.sessions.lock().await;
        let session = sessions
            .get_mut(id)
            .filter(|session| matches!(session.cdn, Cdn::Aksor))
            .ok_or("Сессия просмотра DASH истекла.")?;
        let base = session
            .resources
            .get(resource)
            .ok_or("Неизвестный манифест DASH.")?;
        let parsed = crate::download_dash::localize(text, quality, base)?;
        let mut parts = Vec::with_capacity(parsed.parts.len());
        for (name, url) in parsed.parts {
            let url = media_url(session.cdn, url.as_str())?;
            let child = session.register(url)?;
            parts.push((name, format!("/media/{id}/{child}")));
        }
        Ok((parsed.text, parts))
    }

    pub async fn relay(
        &self,
        client: &Client,
        session: &str,
        resource: &str,
        method: Method,
        headers: HeaderMap,
        #[cfg(any(desktop, target_os = "android"))] proxy_enabled: bool,
    ) -> Result<Response<Vec<u8>>> {
        let (mut url, cdn, client) = {
            let mut sessions = self.sessions.lock().await;
            let session = sessions
                .get_mut(session)
                .filter(|s| s.used.elapsed() < Duration::from_secs(180))
                .ok_or("Сессия просмотра истекла.")?;
            #[cfg(any(desktop, target_os = "android"))]
            if let Some(playlist) = session.hls_playlists.get(resource) {
                session.used = Instant::now();
                let body = if method == Method::HEAD {
                    Vec::new()
                } else {
                    playlist.as_bytes().to_vec()
                };
                return Ok(Response::builder()
                    .header("content-type", "application/vnd.apple.mpegurl")
                    .header("content-length", playlist.len())
                    .body(body)
                    .unwrap());
            }
            #[cfg(any(desktop, target_os = "android"))]
            let client = session
                .aksor_proxy
                .as_ref()
                .filter(|_| proxy_enabled)
                .unwrap_or(client);
            let url = session
                .resources
                .get(resource)
                .ok_or("Неизвестный медиаресурс.")?
                .clone();
            session.used = Instant::now();
            (url, session.cdn, client.clone())
        };
        let provider = cdn.label();
        let range = bounded_range(headers.get("range").and_then(|v| v.to_str().ok()))?;
        for _ in 0..4 {
            // Only native headers go upstream. Browser Origin/Sec-Fetch/Accept
            // make okcdn reject a playable H.264/AAC file with HTTP 400.
            let path = url.path().to_ascii_lowercase();
            // On a slow connection a DASH fragment can take minutes while still
            // making progress. Restarting its complete request would discard
            // the bytes already received.
            #[cfg(desktop)]
            let streamed_fragment = matches!(cdn, Cdn::Aksor) && path.ends_with(".m4s");
            #[cfg(not(desktop))]
            let streamed_fragment = false;
            #[cfg(desktop)]
            let client = if streamed_fragment {
                self.aksor
                    .get_or_try_init(|| async {
                        Client::builder()
                            .user_agent("Mozilla/5.0")
                            .redirect(reqwest::redirect::Policy::none())
                            .connect_timeout(Duration::from_secs(8))
                            .read_timeout(Duration::from_secs(25))
                            .build()
                    })
                    .await
                    .map_err(|_| "Не удалось подключить транспорт Aksor.")?
            } else {
                &client
            };
            let mut request = client.request(method.clone(), url.clone());
            if !streamed_fragment {
                request = request.timeout(Duration::from_secs(25));
            }
            #[cfg(any(desktop, target_os = "android"))]
            if provider == "Aksor" {
                request = request
                    .header("Accept-Encoding", "identity")
                    .header("Referer", crate::providers::AKSOR_MEDIA_REFERER);
            }
            if method == Method::GET
                && !path.ends_with(".m3u8")
                && (headers.contains_key("range") || path.ends_with(".mp4"))
            {
                request = request.header("Range", &range);
                if let Some(validator) = headers.get("if-range") {
                    request = request.header("If-Range", validator);
                }
            }
            let response = if matches!(provider, "Kodik" | "Aksor") {
                send_with_server_retry(request).await
            } else {
                request.send().await
            }
            .map_err(|_| format!("Нет связи с {provider}."))?;
            if response.status().is_redirection() {
                let location = response
                    .headers()
                    .get("location")
                    .and_then(|v| v.to_str().ok())
                    .ok_or_else(|| format!("Некорректное перенаправление {provider}."))?;
                let target = media_url(
                    cdn,
                    url.join(location)
                        .map_err(|_| format!("Некорректное перенаправление {provider}."))?
                        .as_str(),
                )?;
                // A validated CDN can redirect an asset to another node.
                // Bind relative playlist resources to the final directory.
                #[cfg(desktop)]
                if !matches!(cdn, Cdn::Cvh) {
                    let root = target
                        .join("./")
                        .map_err(|_| format!("Некорректный адрес {provider}."))?;
                    let mut sessions = self.sessions.lock().await;
                    if let Some(state) = sessions.get_mut(session) {
                        if !state.roots.contains(&root) {
                            state.roots.push(root);
                        }
                        if matches!(cdn, Cdn::Aksor) && target.path().ends_with(".mpd") {
                            state.resources.insert(resource.to_owned(), target.clone());
                        }
                    }
                }
                url = target;
                continue;
            }
            let playlist = response
                .headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok())
                .is_some_and(|v| v.to_lowercase().contains("mpegurl"))
                || path.ends_with(".m3u8");
            if playlist && method == Method::GET && response.status().is_success() {
                let bytes = limited_body(response, 512000).await?;
                #[cfg(desktop)]
                let revision = crate::downloads::manifest_digest(&bytes);
                let text = std::str::from_utf8(&bytes)
                    .map_err(|_| format!("Некорректный плейлист {provider}."))?;
                let mut sessions = self.sessions.lock().await;
                let state = sessions
                    .get_mut(session)
                    .ok_or("Сессия просмотра истекла.")?;
                let text = crate::alloha::rewrite_playlist(text, &url, |raw| {
                    state.register(media_url(cdn, raw)?)
                })?;
                let response =
                    Response::builder().header("content-type", "application/vnd.apple.mpegurl");
                #[cfg(desktop)]
                let response = response.header(crate::downloads::MANIFEST_ID, revision);
                return Ok(response.body(text.into_bytes()).unwrap());
            }
            let mut result = Response::builder().status(response.status());
            for name in [
                "content-type",
                "content-length",
                "content-range",
                "accept-ranges",
                "etag",
            ] {
                if let Some(value) = response.headers().get(name) {
                    result = result.header(name, value);
                }
            }
            let bytes = if method == Method::HEAD || !response.status().is_success() {
                Vec::new()
            } else {
                limited_body(response, 32 * 1024 * 1024).await?
            };
            return Ok(result.body(bytes).unwrap());
        }
        Err(format!("Слишком много перенаправлений {provider}."))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn bounds_open_ended_suffix_and_explicit_ranges() {
        assert_eq!(bounded_range(Some("bytes=0-1")).unwrap(), "bytes=0-1");
        assert_eq!(
            bounded_range(Some("bytes=100-")).unwrap(),
            "bytes=100-8388707"
        );
        assert_eq!(
            bounded_range(Some("bytes=-99999999")).unwrap(),
            "bytes=-8388608"
        );
        for raw in ["bytes=10-1", "bytes=0-1,5-7", "bytes=-0", "bytes=a-b"] {
            assert!(bounded_range(Some(raw)).is_err());
        }
    }
    #[tokio::test]
    async fn registers_only_known_cdn_urls_and_hides_them_from_media_urls() {
        let media = Media::default();
        let result=media.register(json!({"provider":"CVH","streams":[{"quality":360,"type":"mp4","url":"https://vd249.okcdn.ru/video.mp4"}]})).await.unwrap();
        assert_eq!(result["relay"], true);
        assert!(result["streams"][0]["url"]
            .as_str()
            .unwrap()
            .starts_with("media/"));
        let vk=media.register(json!({"provider":"CVH","streams":[{"quality":360,"type":"hls","url":"https://ok30-3.vkuser.net/video.m3u8?cmd=videoPlayerCdn"}]})).await.unwrap();
        assert_eq!(vk["streams"][0]["sourceHost"], "ok30-3.vkuser.net");
        assert!(media_url(
            Cdn::Cvh,
            "https://ok30-3.vkuser.net.evil.example/video.m3u8"
        )
        .is_err());
        assert!(media
            .register(json!({"streams":[{"url":"https://127.0.0.1/private"}]}))
            .await
            .is_err());
    }

    #[cfg(desktop)]
    #[tokio::test]
    async fn registers_kodik_and_aksor_independently_and_keeps_their_playback_fallback() {
        let media = Media::default();
        let result = json!({"provider":"Kodik","videoId":1,"streams":[
            {"url":"https://cloud2.solodcdn.com/video/480.mp4:hls:manifest.m3u8","type":"hls",
                "fallback":{"type":"mp4","url":"https://cloud2.solodcdn.com/video/480.mp4"}},
            {"url":"https://cloud2.solodcdn.com.example/video.m3u8","type":"hls"}
        ]});
        let registered = media.register(result.clone()).await.unwrap();
        assert_eq!(registered, media.register(result).await.unwrap());
        let streams = registered["streams"].as_array().unwrap();
        assert!(streams[0]["url"].as_str().unwrap().starts_with("media/"));
        assert!(streams[0]["fallback"]["url"]
            .as_str()
            .unwrap()
            .starts_with("media/"));
        assert_eq!(
            streams[0]["fallback"]["legacyUrl"],
            "https://cloud2.solodcdn.com/video/480.mp4"
        );
        assert_eq!(
            streams[1]["url"],
            "https://cloud2.solodcdn.com.example/video.m3u8"
        );
        assert!(!direct_media_supported(
            "Aksor",
            "https://cloud2.solodcdn.com/video.mpd"
        ));
        assert!(!direct_media_supported(
            "Kodik",
            "https://cdn10.takehost-cdn.aksor.tv/video.mpd"
        ));
        assert!(direct_media_supported(
            "Aksor",
            "https://cdn10.takehost-cdn.aksor.tv/video.mpd"
        ));
    }
}

use reqwest::Client;
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};
#[cfg(desktop)]
use tauri::http::HeaderMap;
use tauri::http::{header, Method, Request, Response, StatusCode};
use tokio::sync::{Mutex, Semaphore};

use crate::{
    alloha::{self, Sessions},
    providers::{self, Candidate},
};

#[path = "proxy_pool.rs"]
mod proxy_pool;
pub(crate) use proxy_pool::{CustomProxyChange, PoolPreferences, PoolReport};

#[cfg(desktop)]
pub fn download_format(kind: &str) -> u8 {
    match kind {
        "hls" => 3,
        "dash" => 2,
        "mp4" => 1,
        _ => 0,
    }
}

type Cache = Arc<Mutex<HashMap<String, (Instant, Value)>>>;
type SourceResolution = tokio::sync::OnceCell<Result<Resolved, String>>;
type SourceCache = Arc<Mutex<HashMap<Candidate, (Instant, Arc<SourceResolution>)>>>;
const SOURCE_PRIORITY_WINDOW: Duration = Duration::from_secs(2);
const RESOLUTION_TTL: Duration = Duration::from_secs(30);
const AKSOR_MANIFEST_PREFIX: usize = 4096;
type ReserveRank = (bool, bool, bool, u64, usize);

fn is_dash_manifest_prefix(bytes: &[u8]) -> bool {
    use quick_xml::{events::Event, Reader};

    let mut xml = Reader::from_reader(bytes);
    xml.config_mut().trim_text(true);
    loop {
        match xml.read_event() {
            Ok(Event::Start(root) | Event::Empty(root)) => {
                return root.local_name().as_ref() == "MPD";
            }
            Ok(Event::Decl(_) | Event::PI(_) | Event::Comment(_) | Event::DocType(_)) => {}
            _ => return false,
        }
    }
}

async fn aksor_stream_error(client: &Client, mut url: url::Url, dash: bool) -> Option<String> {
    for _ in 0..4 {
        let request = client
            .request(if dash { Method::GET } else { Method::HEAD }, url.clone())
            .header(header::REFERER, providers::AKSOR_MEDIA_REFERER);
        let mut response = if dash {
            providers::send_with_server_retry(request).await.ok()?
        } else {
            request.send().await.ok()?
        };
        let status = response.status();
        if status.is_redirection() {
            let target = response
                .headers()
                .get(header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .and_then(|raw| url.join(raw).ok());
            let Some(target) = target else {
                return Some("Aksor вернул неизвестный адрес видеопотока.".into());
            };
            if !providers::is_aksor_media_url(&target) {
                return None;
            }
            url = target;
            continue;
        }
        if matches!(status.as_u16(), 404 | 410) || (dash && !status.is_success()) {
            return Some(format!(
                "Aksor · видеопоток недоступен (HTTP {}).",
                status.as_u16()
            ));
        }
        if !dash {
            return None;
        }
        let mut prefix = Vec::new();
        while let Some(chunk) = response.chunk().await.ok()? {
            let remaining = AKSOR_MANIFEST_PREFIX - prefix.len();
            prefix.extend_from_slice(&chunk[..chunk.len().min(remaining)]);
            if is_dash_manifest_prefix(&prefix) {
                return None;
            }
            if prefix.len() == AKSOR_MANIFEST_PREFIX {
                break;
            }
        }
        return Some(format!(
            "Aksor · нет манифеста DASH (HTTP {}).",
            status.as_u16()
        ));
    }
    Some("Aksor · слишком много перенаправлений.".into())
}

#[derive(Clone)]
enum Resolved {
    Direct(Value),
    Alloha(alloha::Pending),
}

struct Attempt {
    index: usize,
    result: Result<Resolved, String>,
}

impl Resolved {
    fn result(&self) -> &Value {
        match self {
            Self::Direct(value) => value,
            Self::Alloha(pending) => pending.result(),
        }
    }

    fn streams(&self) -> impl Iterator<Item = &Value> {
        self.result()["streams"].as_array().into_iter().flatten()
    }

    fn reserve_rank(&self, quality: Option<u32>, index: usize) -> Option<ReserveRank> {
        let is_kodik = self.result()["provider"] == "Kodik";
        let slow = |stream: &Value| is_kodik && stream["type"] == "mp4";
        let has_regular = self.streams().any(|stream| !slow(stream));
        let Some(target) = quality.map(u64::from) else {
            return (is_kodik && !has_regular).then_some((false, true, false, 0, index));
        };
        self.streams()
            .filter_map(|stream| {
                let quality = stream["quality"].as_u64()?;
                let slow = slow(stream);
                let exact = quality == target;
                (exact || !slow || !has_regular).then_some((
                    !exact,
                    slow,
                    quality > target,
                    quality.abs_diff(target),
                    index,
                ))
            })
            .min()
            .filter(|rank| rank.0 || rank.1)
    }

    async fn finish(self, backend: &Backend) -> Result<Value, String> {
        match self {
            Self::Alloha(pending) => Ok(alloha::commit(pending, &backend.sessions).await),
            Self::Direct(value) if value["provider"] == "CVH" => {
                backend.media.register(value).await
            }
            #[cfg(desktop)]
            Self::Direct(value)
                if matches!(value["provider"].as_str(), Some("Kodik" | "Aksor"))
                    && backend.downloads.is_some() =>
            {
                backend.media.register(value).await
            }
            Self::Direct(value) => Ok(value),
        }
    }
}

/// Provider resolution and transport shared by WebView and native playback.
#[derive(Clone)]
pub struct Backend {
    pub client: Client,
    sessions: Sessions,
    cache: Cache,
    sources: SourceCache,
    transfers: Arc<Semaphore>,
    proxies: proxy_pool::Pool,
    #[cfg(desktop)]
    background: Arc<Semaphore>,
    #[cfg(desktop)]
    background_only: bool,
    media: crate::media::Media,
    #[cfg(desktop)]
    pub downloads: Option<crate::downloads::Store>,
    #[cfg(all(test, desktop))]
    pub fixture: Option<crate::downloads::tests::Fixture>,
}

impl Backend {
    pub fn new() -> Result<Self, reqwest::Error> {
        Ok(Self {
            client: Client::builder()
                .user_agent("Mozilla/5.0")
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(8))
                .build()?,
            sessions: Arc::default(),
            cache: Arc::default(),
            sources: Arc::default(),
            transfers: Arc::new(Semaphore::new(8)),
            proxies: proxy_pool::Pool::new(None),
            #[cfg(desktop)]
            background: Arc::new(Semaphore::new(5)),
            #[cfg(desktop)]
            background_only: false,
            media: crate::media::Media::default(),
            #[cfg(desktop)]
            downloads: None,
            #[cfg(all(test, desktop))]
            fixture: None,
        })
    }

    pub fn with_proxy_settings(mut self, file: std::path::PathBuf) -> Self {
        self.proxies = proxy_pool::Pool::new(Some(file));
        self
    }

    pub fn proxy_settings(&self, enabled: Option<bool>) -> Result<bool, String> {
        self.proxies.settings(enabled)
    }

    pub(crate) fn proxy_pool_report(
        &self,
        preferences: Option<PoolPreferences>,
        check_now: bool,
    ) -> Result<PoolReport, String> {
        self.proxies.report(preferences, check_now)
    }

    pub(crate) fn edit_custom_proxy(
        &self,
        change: CustomProxyChange,
    ) -> Result<PoolReport, String> {
        self.proxies.edit_custom(change)?;
        self.proxies.report(None, false)
    }

    pub fn start_proxy_checks(&self) {
        self.proxies.start(self.client.clone());
    }

    #[cfg(any(desktop, target_os = "android"))]
    pub async fn aksor_hls(&self, url: url::Url) -> Result<String, String> {
        match self
            .media
            .aksor_hls(self.client.clone(), url.clone(), false)
            .await
        {
            Err(error) if providers::should_retry_with_proxy(&error) => {
                self.proxies
                    .retry("aksor", error, |client| {
                        self.media.aksor_hls(client, url.clone(), true)
                    })
                    .await
            }
            result => result,
        }
    }

    pub async fn resolve(&self, candidates: Vec<Candidate>) -> Result<Value, String> {
        self.resolve_quality(candidates, None).await
    }

    fn validate_candidates(candidates: &[Candidate]) -> Result<(), String> {
        if candidates.is_empty()
            || candidates.len() > 12
            || candidates
                .iter()
                .any(|c| c.url.len() > 4096 || c.dubbing.len() > 512 || c.episode.len() > 32)
        {
            return Err("Нужны источники выбранной серии.".into());
        }
        Ok(())
    }

    pub async fn resolve_quality(
        &self,
        candidates: Vec<Candidate>,
        quality: Option<u32>,
    ) -> Result<Value, String> {
        Self::validate_candidates(&candidates)?;
        let key = serde_json::to_string(&(&candidates, quality))
            .map_err(|_| "Некорректные источники.".to_string())?;
        {
            let cache = self.cache.lock().await;
            if let Some((_, value)) = cache
                .get(&key)
                .filter(|(time, _)| time.elapsed() < RESOLUTION_TTL)
            {
                return Ok(value.clone());
            }
        }
        // Start reserves with a small priority stagger. A hung provider must not
        // consume the entire request deadline before the other candidates run.
        let mut attempts = tokio::task::JoinSet::new();
        for (index, candidate) in candidates.into_iter().enumerate() {
            let backend = self.clone();
            attempts.spawn(async move {
                tokio::time::sleep(Duration::from_millis(index as u64 * 300)).await;
                let result = backend.prepare_source(candidate).await;
                Attempt { index, result }
            });
        }
        let result = first_available(attempts, quality)
            .await?
            .finish(self)
            .await?;
        let mut cache = self.cache.lock().await;
        cache.retain(|_, (time, _)| time.elapsed() < RESOLUTION_TTL);
        if cache.len() >= 64 {
            if let Some(oldest) = cache
                .iter()
                .min_by_key(|(_, (time, _))| time)
                .map(|(key, _)| key.clone())
            {
                cache.remove(&oldest);
            }
        }
        cache.insert(key, (Instant::now(), result.clone()));
        Ok(result)
    }

    async fn prepare_source(&self, candidate: Candidate) -> Result<Resolved, String> {
        let resolution = {
            let mut sources = self.sources.lock().await;
            sources.retain(|_, (time, _)| time.elapsed() < RESOLUTION_TTL);
            if sources.len() >= 64 && !sources.contains_key(&candidate) {
                if let Some(oldest) = sources
                    .iter()
                    .min_by_key(|(_, (time, _))| time)
                    .map(|(key, _)| key.clone())
                {
                    sources.remove(&oldest);
                }
            }
            sources
                .entry(candidate.clone())
                .or_insert_with(|| (Instant::now(), Arc::default()))
                .1
                .clone()
        };
        let result = resolution
            .get_or_init(|| async {
                let (url, family) = providers::provider_url(&candidate.url)?;
                let provider = match family {
                    "aksor" => "Aksor",
                    "kodik" => "Kodik",
                    "alloha" => "Alloha",
                    _ => "CVH",
                };
                let resolve = |client| Self::resolve_source(&candidate, &url, family, client);
                let timeout = Duration::from_secs(if self.proxies.enabled() { 10 } else { 20 });
                let direct = tokio::time::timeout(timeout, resolve(self.client.clone()))
                    .await
                    .unwrap_or_else(|_| Err("Источник не ответил вовремя.".into()))
                    .map_err(|error| {
                        if providers::should_retry_with_proxy(&error)
                            && !error.starts_with(provider)
                        {
                            format!("{provider} · {error}")
                        } else {
                            error
                        }
                    });
                match direct {
                    Err(error) if providers::should_retry_with_proxy(&error) => {
                        self.proxies.retry(family, error, resolve).await
                    }
                    result => result,
                }
            })
            .await;
        if result.is_err() {
            let mut sources = self.sources.lock().await;
            if sources
                .get(&candidate)
                .is_some_and(|(_, current)| Arc::ptr_eq(current, &resolution))
            {
                sources.remove(&candidate);
            }
        }
        result.clone()
    }

    async fn resolve_source(
        candidate: &Candidate,
        url: &url::Url,
        family: &str,
        client: Client,
    ) -> Result<Resolved, String> {
        if family == "alloha" {
            return Ok(Resolved::Alloha(
                alloha::prepare(url, candidate, &client).await?,
            ));
        }
        let value = providers::resolve(candidate, &client).await?;
        let value = if family == "aksor" {
            Self::available_aksor_streams(value, &client).await?
        } else {
            value
        };
        Ok(Resolved::Direct(value))
    }

    pub async fn inspect_qualities(&self, candidates: Vec<Candidate>) -> Result<Vec<u32>, String> {
        Self::validate_candidates(&candidates)?;
        let mut attempts = tokio::task::JoinSet::new();
        let slots = Arc::new(Semaphore::new(3));
        for candidate in candidates {
            let backend = self.clone();
            let slots = slots.clone();
            attempts.spawn(async move {
                let _slot = slots
                    .acquire()
                    .await
                    .expect("quality probe semaphore is open");
                backend.prepare_source(candidate).await
            });
        }
        let mut qualities = std::collections::BTreeSet::new();
        while let Some(attempt) = attempts.join_next().await {
            if let Ok(Ok(source)) = attempt {
                qualities.extend(source.streams().filter_map(|stream| {
                    u32::try_from(stream["quality"].as_u64()?)
                        .ok()
                        .filter(|q| *q > 0)
                }));
            }
        }
        Ok(qualities.into_iter().collect())
    }

    async fn available_aksor_streams(mut result: Value, client: &Client) -> Result<Value, String> {
        let mut probes = tokio::task::JoinSet::new();
        let mut seen = std::collections::HashSet::new();
        for stream in result["streams"].as_array().ok_or("Нет потоков Aksor.")? {
            let Some(raw) = stream["url"].as_str() else {
                continue;
            };
            let Ok(url) = url::Url::parse(raw) else {
                continue;
            };
            if !providers::is_aksor_media_url(&url) || !seen.insert(raw.to_owned()) {
                continue;
            }
            let client = client.clone();
            let raw = raw.to_owned();
            let dash = stream["type"] == "dash";
            probes.spawn(async move {
                let error = tokio::time::timeout(
                    Duration::from_secs(3),
                    aksor_stream_error(&client, url, dash),
                )
                .await
                .ok()
                .flatten();
                (raw, error)
            });
        }
        let mut unavailable = HashMap::new();
        while let Some(probe) = probes.join_next().await {
            if let Ok((url, Some(error))) = probe {
                unavailable.insert(url, error);
            }
        }
        let streams = result["streams"]
            .as_array_mut()
            .ok_or("Нет потоков Aksor.")?;
        let error = streams
            .iter()
            .find_map(|stream| unavailable.get(stream["url"].as_str()?).cloned());
        streams.retain(|stream| {
            !stream["url"]
                .as_str()
                .is_some_and(|url| unavailable.contains_key(url))
        });
        if streams.is_empty() {
            return Err(error.unwrap_or_else(|| "Нет потоков Aksor.".into()));
        }
        Ok(result)
    }

    #[cfg(desktop)]
    pub fn with_downloads(mut self, downloads: crate::downloads::Store) -> Self {
        self.downloads = Some(downloads);
        self
    }

    #[cfg(desktop)]
    pub async fn resolve_download(
        &self,
        candidates: &[Candidate],
        quality: u32,
    ) -> Result<Value, String> {
        Self::validate_candidates(candidates)?;
        let mut reserves = Vec::new();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(25);
        let mut last_error = format!("В выбранной озвучке нет качества {quality}p или ниже.");
        for candidate in candidates {
            match tokio::time::timeout_at(deadline, self.prepare_source(candidate.clone())).await {
                Ok(Ok(source)) => {
                    let provider = source.result()["provider"].as_str().unwrap_or_default();
                    let variant = source
                        .streams()
                        .filter_map(|stream| {
                            let height = u32::try_from(stream["quality"].as_u64()?).ok()?;
                            let format = download_format(stream["type"].as_str()?);
                            let supported = !matches!(provider, "Kodik" | "Aksor")
                                || stream["url"].as_str().is_some_and(|raw| {
                                    crate::media::direct_media_supported(provider, raw)
                                });
                            (supported && format > 0 && height <= quality)
                                .then_some((height, format))
                        })
                        .max();
                    if let Some(rank) = variant {
                        if rank == (quality, download_format("hls")) {
                            match source.finish(self).await {
                                Ok(result) => return Ok(result),
                                Err(reason) => last_error = reason,
                            }
                        } else {
                            reserves.push((rank, source));
                        }
                    }
                }
                Ok(Err(reason)) => last_error = reason,
                Err(_) => break,
            }
        }
        reserves.sort_by_key(|(rank, _)| std::cmp::Reverse(*rank));
        for (_, source) in reserves {
            match source.finish(self).await {
                Ok(result) => return Ok(result),
                Err(reason) => last_error = reason,
            }
        }
        Err(last_error)
    }

    #[cfg(desktop)]
    pub async fn dash_manifest(
        &self,
        upstream: &str,
        quality: u32,
        text: &str,
    ) -> Result<(String, Vec<(String, String)>), String> {
        self.media.dash_manifest(upstream, quality, text).await
    }

    #[cfg(desktop)]
    pub fn background_downloads(&self) -> Self {
        let mut backend = self.clone();
        backend.background_only = true;
        backend
    }

    #[cfg(desktop)]
    pub async fn download_resource_url(&self, path: &str) -> Option<String> {
        #[cfg(test)]
        if self.fixture.is_some() {
            return Some(path.to_owned());
        }
        let (provider, ids) = path.strip_prefix('/')?.split_once('/')?;
        let (session, resource) = ids.split_once('/')?;
        match provider {
            "media" => self.media.resource_url(session, resource).await,
            "alloha" => alloha::resource_url(&self.sessions, session, resource).await,
            _ => None,
        }
        .map(|url| url.to_string())
    }

    #[cfg(desktop)]
    pub async fn forget_download_sources(&self, candidates: &[Candidate]) {
        let mut sources = self.sources.lock().await;
        for candidate in candidates {
            sources.remove(candidate);
        }
    }

    #[cfg(desktop)]
    pub async fn download_upstream(
        &self,
        path: &str,
        headers: HeaderMap,
    ) -> Result<Response<Vec<u8>>, String> {
        self.download_upstream_method(path, Method::GET, headers)
            .await
    }

    #[cfg(desktop)]
    pub async fn download_upstream_method(
        &self,
        path: &str,
        method: Method,
        headers: HeaderMap,
    ) -> Result<Response<Vec<u8>>, String> {
        #[cfg(test)]
        if let Some(fixture) = &self.fixture {
            return fixture.fetch(path, headers).await;
        }
        let (provider, ids) = path
            .strip_prefix('/')
            .and_then(|path| path.split_once('/'))
            .ok_or("Неизвестный поток.")?;
        let (session, resource) = ids.split_once('/').ok_or("Неизвестный поток.")?;
        let _background = if self.background_only {
            Some(
                self.background
                    .acquire()
                    .await
                    .map_err(|_| "Транспорт недоступен.")?,
            )
        } else {
            None
        };
        let _permit = self
            .transfers
            .acquire()
            .await
            .map_err(|_| "Транспорт недоступен.")?;
        match provider {
            "media" => {
                self.media
                    .relay(
                        &self.client,
                        session,
                        resource,
                        method,
                        headers,
                        self.proxies.enabled(),
                    )
                    .await
            }
            "alloha" => {
                alloha::relay(
                    &self.client,
                    &self.sessions,
                    session,
                    resource,
                    method,
                    headers,
                )
                .await
            }
            _ => Err("Неизвестный поток.".into()),
        }
    }

    async fn saved_media(&self, request: &Request<Vec<u8>>) -> Option<Response<Vec<u8>>> {
        #[cfg(desktop)]
        {
            let store = self.downloads.as_ref()?;
            let (id, resource) = crate::downloads::route(request.uri().path())?;
            if request.uri().query().is_some()
                || !matches!(*request.method(), Method::GET | Method::HEAD)
            {
                return Some(error(StatusCode::METHOD_NOT_ALLOWED, "Method not allowed"));
            }
            Some(
                store
                    .serve(
                        self,
                        id,
                        resource,
                        request.method().clone(),
                        request.headers(),
                    )
                    .await,
            )
        }
        #[cfg(not(desktop))]
        {
            let _ = request;
            None
        }
    }

    /// Tauri/WebView intercepts this scheme in-process. It never reaches the network stack.
    pub async fn media(&self, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
        let origin = request.headers().get(header::ORIGIN).cloned();
        if origin
            .as_ref()
            .is_some_and(|value| !local_origin(value.to_str().unwrap_or("")))
        {
            return error(StatusCode::FORBIDDEN, "Local origins only");
        }
        let mut response = if request.method() == Method::OPTIONS {
            Response::builder()
                .status(StatusCode::NO_CONTENT)
                .body(Vec::new())
                .unwrap()
        } else if let Some(response) = self.saved_media(&request).await {
            response
        } else {
            let ids: Vec<_> = request
                .uri()
                .path()
                .trim_start_matches('/')
                .split('/')
                .collect();
            if ids.len() != 3
                || !matches!(ids[0], "alloha" | "media")
                || ids[1..].iter().any(|id| {
                    id.len() != 32
                        || !id
                            .bytes()
                            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
                })
            {
                return error(StatusCode::NOT_FOUND, "Unknown resource");
            }
            if !matches!(*request.method(), Method::GET | Method::HEAD) {
                return error(StatusCode::METHOD_NOT_ALLOWED, "Method not allowed");
            }
            let _permit = self
                .transfers
                .acquire()
                .await
                .expect("transfer semaphore closed");
            let result = if ids[0] == "media" {
                self.media
                    .relay(
                        &self.client,
                        ids[1],
                        ids[2],
                        request.method().clone(),
                        request.headers().clone(),
                        #[cfg(any(desktop, target_os = "android"))]
                        self.proxies.enabled(),
                    )
                    .await
            } else {
                alloha::relay(
                    &self.client,
                    &self.sessions,
                    ids[1],
                    ids[2],
                    request.method().clone(),
                    request.headers().clone(),
                )
                .await
            };
            match result {
                Ok(response) => response,
                Err(message) => error(
                    if message.contains("истекла") {
                        StatusCode::GONE
                    } else {
                        StatusCode::BAD_GATEWAY
                    },
                    &message,
                ),
            }
        };
        let headers = response.headers_mut();
        headers.insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
        headers.insert(
            header::ACCESS_CONTROL_ALLOW_METHODS,
            "GET, HEAD, OPTIONS".parse().unwrap(),
        );
        headers.insert(
            header::ACCESS_CONTROL_ALLOW_HEADERS,
            "Range, Content-Type".parse().unwrap(),
        );
        headers.insert(
            header::ACCESS_CONTROL_EXPOSE_HEADERS,
            "Content-Length, Content-Range, Accept-Ranges"
                .parse()
                .unwrap(),
        );
        if let Some(origin) = origin {
            headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
            headers.insert(header::VARY, "Origin".parse().unwrap());
        }
        response
    }
}

fn local_origin(origin: &str) -> bool {
    if matches!(
        origin,
        "tauri://localhost" | "http://tauri.localhost" | "https://tauri.localhost"
    ) {
        return true;
    }
    // Vite is used only during development, never in the packaged application.
    cfg!(debug_assertions)
        && url::Url::parse(origin).is_ok_and(|url| {
            url.scheme() == "http"
                && matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))
                && url.path() == "/"
        })
}

pub fn error(status: StatusCode, message: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(message.as_bytes().to_vec())
        .unwrap()
}

// Dropping JoinSet cancels unfinished requests. Resolutions hold unregistered
// sessions, so discarded and cancelled attempts cannot evict the selected one.
async fn first_available(
    mut attempts: tokio::task::JoinSet<Attempt>,
    quality: Option<u32>,
) -> Result<Resolved, String> {
    let mut errors = Vec::new();
    let mut preferred_pending = true;
    let priority_window = tokio::time::sleep(SOURCE_PRIORITY_WINDOW);
    tokio::pin!(priority_window);
    let mut reserve: Option<(usize, Resolved)> = None;
    let mut last_resort: Option<(ReserveRank, Resolved)> = None;

    loop {
        tokio::select! {
            attempt = attempts.join_next() => {
                match attempt {
                    Some(Ok(Attempt { index, result: Ok(value) })) => {
                        if let Some(rank) = value.reserve_rank(quality, index) {
                            if last_resort.as_ref().is_none_or(|(current, _)| rank < *current) {
                                last_resort = Some((rank, value));
                            }
                            if index == 0 {
                                preferred_pending = false;
                                if let Some((_, value)) = reserve.take() {
                                    return Ok(value);
                                }
                            }
                        } else if index == 0 || !preferred_pending {
                            return Ok(value);
                        } else if reserve.as_ref().is_none_or(|(current, _)| index < *current) {
                            reserve = Some((index, value));
                        }
                    }
                    Some(Ok(Attempt { index, result: Err(error) })) => {
                        if !errors.contains(&error) {
                            errors.push(error);
                        }
                        if index == 0 {
                            preferred_pending = false;
                            if let Some((_, value)) = reserve.take() {
                                return Ok(value);
                            }
                        }
                    }
                    Some(Err(error)) => {
                        let error = error.to_string();
                        if !errors.contains(&error) {
                            errors.push(error);
                        }
                    }
                    None => {
                        if let Some(value) = reserve.map(|(_, value)| value)
                            .or_else(|| last_resort.map(|(_, value)| value))
                        {
                            return Ok(value);
                        }
                        return Err(errors.join(" "));
                    }
                }
            }
            _ = &mut priority_window, if preferred_pending => {
                preferred_pending = false;
                if let Some((_, value)) = reserve.take() {
                    return Ok(value);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::tests::{candidate, MockUpstream};
    use serde_json::json;
    use url::Url;

    fn direct(index: usize, result: Result<Value, String>) -> Attempt {
        Attempt {
            index,
            result: result.map(Resolved::Direct),
        }
    }

    fn direct_value(resolved: Resolved) -> Value {
        match resolved {
            Resolved::Direct(value) => value,
            Resolved::Alloha(_) => panic!("expected a direct stream"),
        }
    }

    fn variant(index: usize, provider: &str, format: &str, quality: u32) -> Attempt {
        direct(
            index,
            Ok(json!({"provider": provider, "streams": [{"type": format, "quality": quality}]})),
        )
    }

    #[test]
    fn identifies_dash_manifests_by_the_xml_root() {
        assert!(is_dash_manifest_prefix(
            b"\xef\xbb\xbf<?xml version=\"1.0\"?>\n<!-- CDN -->\n<mpd:MPD xmlns:mpd=\"urn:mpeg:dash:schema:mpd:2011\">"
        ));
        assert!(!is_dash_manifest_prefix(b"db817583f6e42996c87406dd"));
        assert!(!is_dash_manifest_prefix(b"<html><MPD/></html>"));
        assert!(!is_dash_manifest_prefix(b"<?xml version=\"1.0\"?><MP"));
    }

    async fn pending_alloha() -> alloha::Pending {
        let url = Url::parse("https://alloha.yani.tv/?token=public").unwrap();
        let upstream = MockUpstream::new(vec![
            r#"<meta name="viewporti" content="abcdefgh"><script src="/build/app.123abc.js"></script><script>const fileList = JSON.parse('{"active":{"id":123}}');</script>"#.into(),
            json!({"hlsSource":[{"label":"(Russian) Dub - Арт-Дубляж","quality":{"360":"https://edge.userplay.live/series/master.m3u8"}}]}).to_string(),
            format!("return '{}'","A".repeat(380)),
        ]);
        alloha::prepare(&url, &candidate(url.as_str(), "Арт-Дубляж"), &upstream)
            .await
            .unwrap()
    }

    #[tokio::test(start_paused = true)]
    async fn slow_source_yields_to_reserve_after_priority_window() {
        let mut attempts = tokio::task::JoinSet::new();
        attempts.spawn(async {
            tokio::time::sleep(Duration::from_secs(20)).await;
            direct(0, Err("Alloha unavailable".to_string()))
        });
        attempts.spawn(async { direct(1, Err("Second provider unavailable".to_string())) });
        attempts.spawn(async {
            tokio::time::sleep(Duration::from_millis(600)).await;
            direct(2, Ok(json!({"provider": "Reserve", "videoId": 3})))
        });
        let started = tokio::time::Instant::now();
        let result = direct_value(super::first_available(attempts, None).await.unwrap());
        assert_eq!(result["videoId"], 3);
        assert!(started.elapsed() >= SOURCE_PRIORITY_WINDOW);
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[tokio::test(start_paused = true)]
    async fn fast_reserve_does_not_preempt_healthy_preferred_source() {
        let mut attempts = tokio::task::JoinSet::new();
        attempts.spawn(async {
            tokio::time::sleep(Duration::from_millis(500)).await;
            direct(0, Ok(json!({"provider": "Preferred", "videoId": 1})))
        });
        attempts.spawn(async {
            tokio::time::sleep(Duration::from_millis(100)).await;
            direct(1, Ok(json!({"provider": "Reserve", "videoId": 2})))
        });
        let started = tokio::time::Instant::now();
        let result = direct_value(super::first_available(attempts, None).await.unwrap());
        assert_eq!(result["videoId"], 1);
        assert!(started.elapsed() < SOURCE_PRIORITY_WINDOW);
    }

    #[tokio::test(start_paused = true)]
    async fn failed_preferred_source_releases_reserve_immediately() {
        let mut attempts = tokio::task::JoinSet::new();
        attempts.spawn(async {
            tokio::time::sleep(Duration::from_millis(200)).await;
            direct(0, Err("Preferred unavailable".to_string()))
        });
        attempts.spawn(async {
            tokio::time::sleep(Duration::from_millis(100)).await;
            direct(1, Ok(json!({"provider": "Reserve", "videoId": 2})))
        });
        let started = tokio::time::Instant::now();
        let result = direct_value(super::first_available(attempts, None).await.unwrap());
        assert_eq!(result["videoId"], 2);
        assert_eq!(started.elapsed(), Duration::from_millis(200));
    }

    #[tokio::test(start_paused = true)]
    async fn kodik_mp4_waits_for_other_sources_even_when_preferred() {
        let mut attempts = tokio::task::JoinSet::new();
        attempts.spawn(async {
            direct(
                0,
                Ok(json!({"provider": "Kodik", "streams": [{"type": "mp4"}]})),
            )
        });
        attempts.spawn(async {
            tokio::time::sleep(SOURCE_PRIORITY_WINDOW + Duration::from_millis(100)).await;
            direct(
                1,
                Ok(json!({"provider": "CVH", "streams": [{"type": "mp4"}]})),
            )
        });

        let result = direct_value(super::first_available(attempts, None).await.unwrap());
        assert_eq!(result["provider"], "CVH");
    }

    #[tokio::test(start_paused = true)]
    async fn kodik_mp4_is_returned_when_other_sources_fail() {
        let mut attempts = tokio::task::JoinSet::new();
        attempts.spawn(async { direct(0, Err("CVH unavailable".to_string())) });
        attempts.spawn(async {
            direct(
                1,
                Ok(json!({"provider": "Kodik", "streams": [{"type": "mp4"}]})),
            )
        });

        let result = direct_value(super::first_available(attempts, None).await.unwrap());
        assert_eq!(result["provider"], "Kodik");
    }

    #[tokio::test(start_paused = true)]
    async fn an_exact_quality_outweighs_a_faster_preferred_candidate() {
        let mut attempts = tokio::task::JoinSet::new();
        attempts.spawn(async { variant(0, "CVH", "mp4", 360) });
        attempts.spawn(async {
            tokio::time::sleep(Duration::from_millis(300)).await;
            variant(1, "Kodik", "mp4", 720)
        });
        attempts.spawn(async {
            tokio::time::sleep(Duration::from_millis(800)).await;
            variant(2, "Alloha", "hls", 720)
        });
        let result = direct_value(super::first_available(attempts, Some(720)).await.unwrap());
        assert_eq!(result["provider"], "Alloha");
    }

    #[tokio::test(start_paused = true)]
    async fn an_exact_kodik_mp4_is_available_when_other_sources_have_only_different_qualities() {
        let mut attempts = tokio::task::JoinSet::new();
        attempts.spawn(async { variant(0, "CVH", "mp4", 480) });
        attempts.spawn(async { variant(1, "Kodik", "mp4", 720) });
        let result = direct_value(super::first_available(attempts, Some(720)).await.unwrap());
        assert_eq!(result["provider"], "Kodik");
    }

    #[tokio::test(start_paused = true)]
    async fn falls_back_to_the_closest_lower_quality_when_no_candidate_matches() {
        let mut attempts = tokio::task::JoinSet::new();
        attempts.spawn(async { variant(0, "CVH", "mp4", 360) });
        attempts.spawn(async { variant(1, "Alloha", "hls", 1080) });
        attempts.spawn(async { variant(2, "Aksor", "dash", 480) });
        let result = direct_value(super::first_available(attempts, Some(720)).await.unwrap());
        assert_eq!(result["provider"], "Aksor");
    }

    #[tokio::test]
    async fn inspects_all_qualities_without_registering_playback_sessions() {
        let backend = Backend::new().unwrap();
        let cvh = candidate(
            "https://ru.yummyani.me/iframeCVH.html?anime_id=1",
            "Арт-Дубляж",
        );
        let alloha = candidate("https://alloha.yani.tv/?token=public", "Арт-Дубляж");
        let sources = [
            (
                cvh.clone(),
                Resolved::Direct(json!({"provider": "CVH", "streams": [
                    {"type": "mp4", "quality": 1080},
                    {"type": "mp4", "quality": 360},
                    {"type": "mp4", "quality": 480},
                ]})),
            ),
            (alloha.clone(), Resolved::Alloha(pending_alloha().await)),
        ];
        {
            let mut cache = backend.sources.lock().await;
            for (candidate, result) in sources {
                let resolution = Arc::new(SourceResolution::new());
                assert!(resolution.set(Ok(result)).is_ok());
                cache.insert(candidate, (Instant::now(), resolution));
            }
        }

        assert_eq!(
            backend.inspect_qualities(vec![cvh, alloha]).await.unwrap(),
            vec![360, 480, 1080]
        );
        assert!(backend.sessions.lock().await.is_empty());
    }

    #[cfg(desktop)]
    #[tokio::test]
    async fn download_quality_uses_the_closest_lower_variant_and_prefers_hls_at_equal_quality() {
        let backend = Backend::new().unwrap();
        let kodik = candidate("https://kodik.info/seria/test", "Студия");
        let aksor = candidate("https://player.aksor.tv/video/test", "Студия");
        let sources = [
            (
                aksor.clone(),
                json!({"provider":"Aksor","streams":[
                {"type":"dash","quality":720,"url":"https://cdn.aksor.tv/720.mpd"},
                {"type":"dash","quality":1440,"url":"https://cdn.aksor.tv/1440.mpd"}]}),
            ),
            (
                kodik.clone(),
                json!({"provider":"Kodik","streams":[
                {"type":"hls","quality":720,"url":"https://cloud2.solodcdn.com/720.m3u8"},
                {"type":"hls","quality":2160,"url":"https://cloud2.solodcdn.com/2160.m3u8"}]}),
            ),
        ];
        {
            let mut cache = backend.sources.lock().await;
            for (candidate, value) in sources {
                let resolution = Arc::new(SourceResolution::new());
                assert!(resolution.set(Ok(Resolved::Direct(value))).is_ok());
                cache.insert(candidate, (Instant::now(), resolution));
            }
        }
        let variants = [aksor, kodik];
        assert_eq!(
            backend.resolve_download(&variants, 1080).await.unwrap()["provider"],
            "Kodik"
        );
        assert_eq!(
            backend.resolve_download(&variants, 1440).await.unwrap()["provider"],
            "Aksor"
        );
        assert!(backend.resolve_download(&variants, 480).await.is_err());
    }

    #[tokio::test(start_paused = true)]
    async fn losing_and_cancelled_attempts_do_not_register_alloha_sessions() {
        let backend = Backend::new().unwrap();
        let preferred = pending_alloha().await;
        let reserve = pending_alloha().await;
        let cancelled = pending_alloha().await;
        assert!(backend.sessions.lock().await.is_empty());

        let mut attempts = tokio::task::JoinSet::new();
        attempts.spawn(async {
            tokio::time::sleep(Duration::from_millis(300)).await;
            Attempt {
                index: 0,
                result: Ok(Resolved::Alloha(preferred)),
            }
        });
        attempts.spawn(async {
            tokio::time::sleep(Duration::from_millis(100)).await;
            Attempt {
                index: 1,
                result: Ok(Resolved::Alloha(reserve)),
            }
        });
        attempts.spawn(async {
            tokio::time::sleep(Duration::from_secs(20)).await;
            Attempt {
                index: 2,
                result: Ok(Resolved::Alloha(cancelled)),
            }
        });

        let selected = super::first_available(attempts, None).await.unwrap();
        assert!(backend.sessions.lock().await.is_empty());
        let result = selected.finish(&backend).await.unwrap();
        assert_eq!(result["provider"], "Alloha");
        assert_eq!(backend.sessions.lock().await.len(), 1);
        tokio::task::yield_now().await;
        assert_eq!(backend.sessions.lock().await.len(), 1);
    }

    #[tokio::test]
    #[ignore = "requires live Yummy/provider network access"]
    async fn live_provider_transport() {
        let backend = Backend::new().unwrap();
        let mut failures = Vec::new();
        let hls_uri = regex::Regex::new(r#"URI="([^"]+)""#).unwrap();
        for (anime, family) in [
            (10531, "aksor"),
            (10531, "kodik"),
            (10531, "alloha"),
            (26053, "cvh"),
            (21747, "cvh"),
            (21747, "kodik"),
            (21747, "alloha"),
        ] {
            let payload: Value = backend
                .client
                .get(format!("https://api.yani.tv/anime/{anime}/videos"))
                .timeout(Duration::from_secs(15))
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            let videos = payload["response"].as_array().expect("Yummy videos");
            let video = videos
                .iter()
                .filter(|v| {
                    providers::provider_url(v["iframe_url"].as_str().unwrap_or(""))
                        .is_ok_and(|(_, f)| f == family)
                })
                .min_by_key(|v| {
                    (
                        !v["data"]["dubbing"]
                            .as_str()
                            .unwrap_or("")
                            .contains(if anime == 21747 { "SHIZA" } else { "AniLibria" }),
                        v["number"]
                            .as_str()
                            .unwrap_or("")
                            .parse::<u32>()
                            .unwrap_or(9999),
                    )
                })
                .expect("provider fixture");
            let input = Candidate {
                url: video["iframe_url"].as_str().unwrap().into(),
                video_id: video["video_id"].as_u64().unwrap(),
                dubbing: video["data"]["dubbing"].as_str().unwrap().into(),
                episode: video["number"].as_str().unwrap().into(),
            };
            let result = match backend.resolve(vec![input]).await {
                Ok(value) => value,
                Err(error) => {
                    println!("{family}: resolver failed: {error}");
                    failures.push(family);
                    continue;
                }
            };
            let stream = result["streams"]
                .as_array()
                .unwrap()
                .iter()
                .min_by_key(|s| s["quality"].as_u64().unwrap())
                .unwrap();
            let path = stream["url"].as_str().unwrap();
            if result["relay"] == true {
                let mut resource =
                    url::Url::parse(&format!("yumiwatch-media://localhost/{path}")).unwrap();
                let mut loaded_segment = false;
                for _ in 0..4 {
                    let response = backend
                        .media(
                            Request::builder()
                                .uri(resource.as_str())
                                .header("Origin", "tauri://localhost")
                                .body(vec![])
                                .unwrap(),
                        )
                        .await;
                    println!(
                        "{family}: native resource {}, bytes={}",
                        response.status(),
                        response.body().len()
                    );
                    if !response.status().is_success() {
                        break;
                    }
                    if !response.body().starts_with(b"#EXTM3U") {
                        loaded_segment = !response.body().is_empty();
                        break;
                    }
                    let manifest = std::str::from_utf8(response.body()).unwrap();
                    // Encryption keys and initialization also use the registered protocol.
                    for line in manifest.lines().filter(|line| {
                        line.starts_with("#EXT-X-KEY:") || line.starts_with("#EXT-X-MAP:")
                    }) {
                        if let Some(captures) = hls_uri.captures(line) {
                            let response = backend
                                .media(
                                    Request::builder()
                                        .uri(resource.join(&captures[1]).unwrap().as_str())
                                        .header("Origin", "tauri://localhost")
                                        .body(vec![])
                                        .unwrap(),
                                )
                                .await;
                            assert!(response.status().is_success(), "HLS key/init failed");
                        }
                    }
                    let next = manifest
                        .lines()
                        .find(|line| !line.starts_with('#') && !line.trim().is_empty())
                        .expect("HLS resource");
                    resource = resource.join(next).unwrap();
                }
                if !loaded_segment {
                    failures.push(family);
                }
            } else {
                // Match the browser: follow media redirects and omit Origin for
                // native MP4, which has no CORS requirement.
                let client = Client::builder()
                    .redirect(reqwest::redirect::Policy::limited(5))
                    .build()
                    .unwrap();
                let mut request = client
                    .get(path)
                    .header("Range", "bytes=0-1023")
                    .timeout(Duration::from_secs(20));
                if stream["type"] != "mp4" {
                    request = request.header("Origin", "tauri://localhost");
                }
                match request.send().await {
                    Ok(response) => {
                        println!(
                            "{family}: {} {} CORS={:?}",
                            stream["type"],
                            response.status(),
                            response.headers().get("access-control-allow-origin")
                        );
                        if !response.status().is_success() {
                            failures.push(family);
                        }
                    }
                    Err(_) => {
                        println!("{family}: media request failed");
                        failures.push(family);
                    }
                }
            }
        }
        assert!(failures.is_empty(), "Failed live providers: {failures:?}");
    }

    #[tokio::test]
    async fn media_protocol_rejects_unregistered_resources() {
        let backend = Backend::new().unwrap();
        assert!(backend.resolve(vec![]).await.is_err());
        assert!(backend
            .resolve(vec![candidate("https://127.0.0.1/private", "Studio")])
            .await
            .is_err());
        let request = Request::builder()
            .uri("yumiwatch-media://localhost/alloha/unknown/resource")
            .body(vec![])
            .unwrap();
        assert_eq!(backend.media(request).await.status(), StatusCode::NOT_FOUND);
        let request = Request::builder()
            .uri(format!(
                "yumiwatch-media://localhost/alloha/{}/{}",
                "a".repeat(32),
                "b".repeat(32)
            ))
            .body(vec![])
            .unwrap();
        assert_eq!(backend.media(request).await.status(), StatusCode::GONE);
        let request = Request::builder()
            .method(Method::OPTIONS)
            .uri("yumiwatch-media://localhost/")
            .header("Origin", "tauri://localhost")
            .body(vec![])
            .unwrap();
        let response = backend.media(request).await;
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        assert_eq!(
            response.headers()["access-control-allow-origin"],
            "tauri://localhost"
        );
        let request = Request::builder()
            .uri("yumiwatch-media://localhost/")
            .header("Origin", "https://evil.example")
            .body(vec![])
            .unwrap();
        assert_eq!(backend.media(request).await.status(), StatusCode::FORBIDDEN);
    }
}

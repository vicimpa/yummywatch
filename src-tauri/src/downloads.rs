use crate::{
    alloha::token,
    backend::{download_format, error, Backend},
    download_hls::{self, ByteRange, Kind},
    providers::{self, Candidate, Result},
};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    io::ErrorKind,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex as StdMutex,
    },
    time::{Duration, Instant},
};
use tauri::http::{header, HeaderMap, Method, Response, StatusCode};
use tokio::{
    fs,
    io::{AsyncReadExt, AsyncSeekExt},
    sync::{Mutex, Notify},
};
use url::Url;

const BLOCK: u64 = 8 * 1024 * 1024;
const MAX_PART: u64 = 64 * 1024 * 1024;
const INDEX: &str = "index.m3u8";
const DASH: &str = "index.mpd";
const VIDEO: &str = "video.mp4";
const CAPTION: &str = "caption.vtt";
const LIMIT: usize = 768;
const RETAIN: Duration = Duration::from_secs(300);
const CACHE_BYTES: u64 = 3 * 1024 * 1024 * 1024;
const CACHE_FREE: u64 = 512 * 1024 * 1024;
pub(crate) const MANIFEST_ID: &str = "x-yumiwatch-manifest-version";

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
struct AnimeMetadata {
    #[serde(skip_serializing_if = "Option::is_none")]
    poster: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    year: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    kind_alias: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    status: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    episodes: Option<Value>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    anime_id: u64,
    title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    anime: Option<AnimeMetadata>,
    episode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    preview: Option<String>,
    voice: String,
    quality: u32,
    candidates: Vec<Candidate>,
    #[serde(
        default,
        deserialize_with = "deserialize_markers",
        skip_serializing_if = "HashMap::is_empty"
    )]
    markers: HashMap<u64, Value>,
    #[serde(default, skip_serializing)]
    active: Option<String>,
}

fn deserialize_markers<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<HashMap<u64, Value>, D::Error> {
    // A flattened Request buffers JSON object keys as strings, even for numeric video IDs.
    Ok(HashMap::<String, Value>::deserialize(deserializer)?
        .into_iter()
        .filter_map(|(id, markers)| id.parse().ok().map(|id| (id, markers)))
        .collect())
}

#[derive(Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum State {
    Queued,
    Downloading,
    Waiting,
    Ready,
    Paused,
    Failed,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    id: String,
    #[serde(flatten)]
    request: Request,
    status: State,
    done: usize,
    total: usize,
    error: Option<String>,
    stream: Option<Ready>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    actual_quality: Option<u32>,
    #[serde(default)]
    started: bool,
    #[serde(default)]
    saved_bytes: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    representation: Option<String>,
    #[serde(skip)]
    retry_at: Option<Instant>,
    #[serde(skip)]
    retries: u32,
    #[serde(skip_deserializing, skip_serializing_if = "Option::is_none", default)]
    waiting_for: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Ready {
    provider: String,
    video_id: u64,
    pub(crate) quality: u32,
    entry: String,
    caption: Option<String>,
    #[serde(default)]
    skips: Value,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct Part {
    upstream: String,
    kind: Kind,
    range: Option<ByteRange>,
}

struct Resource {
    part: Part,
    filename: String,
    lock: Arc<Mutex<()>>,
    interested: AtomicUsize,
    unused: Notify,
}

struct Interest<'a>(&'a Resource);

impl Drop for Interest<'_> {
    fn drop(&mut self) {
        if self.0.interested.fetch_sub(1, Ordering::AcqRel) == 1 {
            self.0.unused.notify_one();
        }
    }
}

impl Resource {
    fn watch(&self) -> Interest<'_> {
        self.interested.fetch_add(1, Ordering::AcqRel);
        Interest(self)
    }

    async fn abandoned(&self) {
        loop {
            if self.interested.load(Ordering::Acquire) == 0 {
                // A seek can replace the request immediately with another
                // waiter for this same segment.
                tokio::time::sleep(Duration::from_secs(1)).await;
                if self.interested.load(Ordering::Acquire) == 0 {
                    return;
                }
            }
            self.unused.notified().await;
        }
    }
}

#[derive(Default)]
struct Resources {
    names: HashMap<String, Arc<Resource>>,
    parts: HashMap<Part, String>,
}

struct Asset {
    id: String,
    provider: String,
    video_id: u64,
    quality: u32,
    entry: &'static str,
    caption: bool,
    skips: StdMutex<Value>,
    folder: PathBuf,
    cache: StdMutex<Option<PathBuf>>,
    used: StdMutex<Instant>,
    resources: StdMutex<Resources>,
    versions: StdMutex<HashMap<Part, String>>,
    blocks: StdMutex<HashMap<u64, Arc<Mutex<()>>>>,
    mp4_version: StdMutex<Option<Mp4Version>>,
    fallback: Option<Arc<Asset>>,
}

#[derive(Clone, Eq, PartialEq)]
struct Mp4Version {
    size: u64,
    tag: Option<String>,
}

impl Asset {
    fn add_skips(&self, markers: &Value) {
        if !markers.is_object() {
            return;
        }
        let mut current = self.skips.lock().unwrap();
        *current = crate::skips::provider_skips(
            &serde_json::json!({"skips": *current, "skip": markers}),
            "",
        );
    }

    fn add(&self, name: Option<&str>, part: Part) -> Result<String> {
        let mut entries = self.resources.lock().unwrap();
        if let Some(current) = entries.parts.get(&part).cloned() {
            if let Some(alias) = name.filter(|alias| *alias != current) {
                let resource = entries.names[&current].clone();
                entries.names.insert(alias.to_owned(), resource);
                return Ok(alias.to_owned());
            }
            return Ok(current);
        }
        if entries.names.len() >= 8192 {
            return Err("В HLS слишком много файлов.".into());
        }
        let name = name
            .map(str::to_owned)
            .unwrap_or_else(|| format!("{}.{}", entries.names.len(), part.kind.extension()));
        entries.parts.insert(part.clone(), name.clone());
        entries.names.insert(
            name.clone(),
            Arc::new(Resource {
                part,
                filename: name.clone(),
                lock: Arc::default(),
                interested: AtomicUsize::new(0),
                unused: Notify::new(),
            }),
        );
        Ok(name)
    }

    fn representation(&self) -> String {
        let versions = self.versions.lock().unwrap();
        let mut manifests: Vec<_> = versions
            .iter()
            .filter(|(part, _)| part.kind.is_playlist() || part.kind == Kind::Dash)
            .map(|(_, version)| version.as_str())
            .collect();
        manifests.sort_unstable();
        digest(&format!(
            "{}:{}:{}:{}:{manifests:?}",
            self.provider, self.video_id, self.quality, self.entry
        ))
    }

    fn cache_folder(&self) -> Option<PathBuf> {
        self.cache.lock().unwrap().clone()
    }

    async fn resource_key(&self, backend: &Backend, part: &Part) -> Option<String> {
        if part.kind.is_playlist() || part.kind == Kind::Dash {
            return None;
        }
        let source = backend.download_resource_url(&part.upstream).await?;
        let revision = self
            .versions
            .lock()
            .unwrap()
            .get(part)
            .cloned()
            .unwrap_or_default();
        Some(digest(&format!(
            "{}:{}:{}:{}:{:?}:{revision}:{source}",
            self.provider,
            self.video_id,
            self.quality,
            self.entry,
            (part.kind, part.range)
        )))
    }

    async fn bytes(
        self: &Arc<Self>,
        backend: &Backend,
        name: &str,
        checkpoint: Option<&Path>,
    ) -> Result<Vec<u8>> {
        *self.used.lock().unwrap() = Instant::now();
        let resource = self
            .resources
            .lock()
            .unwrap()
            .names
            .get(name)
            .cloned()
            .ok_or("Файл серии недоступен.")?;
        let _interest = resource.watch();
        let guard = resource.lock.clone().lock_owned().await;
        let file = self.folder.join(&resource.filename);
        let key = self.resource_key(backend, &resource.part).await;
        let saved = key
            .as_ref()
            .and_then(|key| checkpoint.map(|path| path.join(key)));
        let cached = key
            .as_ref()
            .and_then(|key| self.cache_folder().map(|path| path.join(key)));
        if let Ok(bytes) = fs::read(&file).await {
            if let Some(saved) = &saved {
                link_file(&file, saved).await?;
            } else if let (None, Some(cached)) = (checkpoint, &cached) {
                self.publish_cache(&file, cached).await;
            }
            return Ok(bytes);
        }
        for existing in saved.iter().chain(&cached) {
            if let Ok(bytes) = fs::read(existing).await {
                if cached.as_ref() == Some(existing) {
                    touch_cache(existing).await;
                }
                if let Err(reason) = link_file(existing, &file).await {
                    if checkpoint.is_some() {
                        return Err(reason);
                    }
                }
                if let Some(saved) = &saved {
                    link_file(existing, saved).await?;
                }
                return Ok(bytes);
            }
        }
        let saving = checkpoint.is_some();
        let asset = self.clone();
        let backend = backend.clone();
        let transfer = resource.clone();
        // A seek can release the decoder's request. Keep the transfer alive so
        // an awaiting downloader or a new seek can use the same response.
        let downloaded = file.clone();
        let bytes = tokio::spawn(async move {
            let _guard = guard;
            let bytes = tokio::select! {
                response = asset.fetch_part(&backend, &transfer.part) => response?,
                _ = transfer.abandoned() => return Err("Загрузка сегмента отменена.".into()),
            };
            match write(&file, &bytes).await {
                Ok(()) => {
                    if let (false, Some(cached)) = (saving, cached) {
                        asset.publish_cache(&file, &cached).await;
                    }
                }
                Err(reason) if saving => return Err(reason),
                Err(_) => {}
            }
            Ok(bytes)
        })
        .await
        .map_err(|_| "Загрузка сегмента прервалась.".to_string())??;
        if let Some(saved) = saved {
            link_file(&downloaded, &saved).await?;
        }
        Ok(bytes)
    }

    async fn publish_cache(&self, source: &Path, cached: &Path) {
        if self.cache_folder().as_deref() != cached.parent() {
            return;
        }
        if fs::metadata(cached).await.is_ok() {
            touch_cache(cached).await;
        } else if free_disk(&self.folder).is_none_or(|free| free > CACHE_FREE)
            && link_file(source, cached).await.is_ok()
        {
            touch_cache(cached).await;
        }
    }

    async fn fetch_part(&self, backend: &Backend, part: &Part) -> Result<Vec<u8>> {
        let mut edition = None;
        let bytes = if part.kind.is_playlist() || part.kind == Kind::Dash {
            let response = backend
                .download_upstream(&part.upstream, HeaderMap::new())
                .await?;
            if !response.status().is_success() {
                return Err(format!(
                    "Источник вернул HTTP {}.",
                    response.status().as_u16()
                ));
            }
            edition = response
                .headers()
                .get(MANIFEST_ID)
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned);
            response.into_body()
        } else if let Some(range) = part.range {
            if range.size > MAX_PART {
                return Err("Слишком большой диапазон сегмента HLS.".into());
            }
            let mut bytes = Vec::new();
            while (bytes.len() as u64) < range.size {
                let start = range.start + bytes.len() as u64;
                let end = (start + BLOCK - 1).min(range.start + range.size - 1);
                let (chunk, _) = fetch_range(backend, &part.upstream, start, end).await?;
                bytes.extend_from_slice(&chunk);
            }
            bytes
        } else {
            fetch_whole(backend, &part.upstream).await?
        };
        if part.kind == Kind::Dash {
            let text = std::str::from_utf8(&bytes).map_err(|_| "Некорректный DASH.")?;
            let (text, parts) = backend
                .dash_manifest(&part.upstream, self.quality, text)
                .await?;
            let revision = manifest_digest(text.as_bytes());
            self.versions
                .lock()
                .unwrap()
                .insert(part.clone(), revision.clone());
            for (name, upstream) in parts {
                let fragment = Part {
                    upstream,
                    kind: Kind::Fragment,
                    range: None,
                };
                self.versions
                    .lock()
                    .unwrap()
                    .insert(fragment.clone(), revision.clone());
                self.add(Some(&name), fragment)?;
            }
            return Ok(text.into_bytes());
        }
        if part.kind.is_playlist() {
            let base = relay_url(&part.upstream)?;
            let text = std::str::from_utf8(&bytes).map_err(|_| "Некорректный плейлист HLS.")?;
            self.add_skips(&download_hls::hls_skips(text));
            let revision = edition.unwrap_or_else(|| manifest_digest(text.as_bytes()));
            self.versions
                .lock()
                .unwrap()
                .insert(part.clone(), revision.clone());
            download_hls::localize(text, self.quality, part.kind, |raw, kind, range| {
                let target = base.join(raw).map_err(|_| "Некорректная ссылка HLS.")?;
                let path = target.path();
                if target.origin() != base.origin()
                    || target.query().is_some()
                    || target.fragment().is_some()
                    || !relay_path(path)
                    || path.rsplit_once('/').map(|(parent, _)| parent)
                        != part.upstream.rsplit_once('/').map(|(parent, _)| parent)
                {
                    return Err("Сегмент HLS за пределами потока.".into());
                }
                let resource = Part {
                    upstream: path.into(),
                    kind,
                    range,
                };
                if !kind.is_playlist() {
                    self.versions
                        .lock()
                        .unwrap()
                        .insert(resource.clone(), revision.clone());
                }
                self.add(None, resource)
            })
            .map(String::into_bytes)
        } else {
            if bytes.is_empty() || (part.kind == Kind::Key && bytes.len() != 16) {
                return Err("Источник вернул неполный файл серии.".into());
            }
            Ok(bytes)
        }
    }

    fn filename(&self, name: &str) -> Result<PathBuf> {
        self.resources
            .lock()
            .unwrap()
            .names
            .get(name)
            .map(|resource| self.folder.join(&resource.filename))
            .ok_or_else(|| "Файл серии недоступен.".into())
    }

    fn part(&self, name: &str) -> Result<Part> {
        self.resources
            .lock()
            .unwrap()
            .names
            .get(name)
            .map(|r| r.part.clone())
            .ok_or_else(|| "Файл серии недоступен.".into())
    }

    async fn mp4_block(
        self: &Arc<Self>,
        backend: &Backend,
        offset: u64,
        checkpoint: Option<&Path>,
    ) -> Result<(Vec<u8>, Mp4Version)> {
        let lock = {
            let mut blocks = self.blocks.lock().unwrap();
            blocks.entry(offset).or_default().clone()
        };
        let guard = lock.lock_owned().await;
        let path = self.folder.join(format!("block-{offset}"));
        let known = self.mp4_version.lock().unwrap().clone();
        let copy_paths = |version: &Mp4Version| {
            let tag = version.tag.as_deref().unwrap_or(&self.id);
            let key = digest(&format!(
                "{}:{}:{}:{}:{tag}:{offset}",
                self.provider, self.video_id, self.quality, version.size
            ));
            let saved = checkpoint.map(|folder| folder.join(&key));
            let cached = version
                .tag
                .as_ref()
                .and_then(|_| self.cache_folder().map(|folder| folder.join(&key)));
            (saved, cached)
        };
        if let Some(version) = &known {
            let (saved, cached) = copy_paths(version);
            for existing in std::iter::once(&path).chain(saved.iter()).chain(&cached) {
                if let Ok(bytes) = fs::read(existing).await {
                    if checkpoint.is_some() {
                        link_file(existing, &path).await?;
                    }
                    if let Some(saved) = &saved {
                        link_file(existing, saved).await?;
                    } else if let (None, Some(cached)) = (checkpoint, cached.as_ref()) {
                        self.publish_cache(existing, cached).await;
                    }
                    return Ok((bytes, version.clone()));
                }
            }
            if offset >= version.size {
                return Err("Диапазон за пределами файла MP4.".into());
            }
        }
        let asset = self.clone();
        let backend = backend.clone();
        let _guard = guard;
        let (bytes, version) = asset.fetch_mp4_block(&backend, offset, known).await?;
        match write(&path, &bytes).await {
            Ok(()) => {
                let (saved, cached) = copy_paths(&version);
                if let Some(saved) = saved {
                    link_file(&path, &saved).await?;
                }
                if let (None, Some(cached)) = (checkpoint, cached) {
                    self.publish_cache(&path, &cached).await;
                }
            }
            Err(reason) if checkpoint.is_some() => return Err(reason),
            Err(_) => {}
        }
        Ok((bytes, version))
    }

    async fn prime_mp4_version(&self, backend: &Backend, partial: &Path) {
        if self.mp4_version.lock().unwrap().is_some() {
            return;
        }
        let cached = self.cache_folder().is_some_and(|folder| folder.is_dir());
        if !cached && !partial.is_dir() {
            return;
        }
        let Ok(part) = self.part(VIDEO) else { return };
        let Ok(response) = backend
            .download_upstream_method(&part.upstream, Method::HEAD, HeaderMap::new())
            .await
        else {
            return;
        };
        if response.status() != StatusCode::OK {
            return;
        }
        let tag = response
            .headers()
            .get(header::ETAG)
            .and_then(|value| value.to_str().ok())
            .filter(|value| value.starts_with('"'))
            .map(str::to_owned);
        let size = response
            .headers()
            .get(header::CONTENT_LENGTH)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u64>().ok())
            .filter(|size| *size > 0);
        if let (Some(tag), Some(size)) = (tag, size) {
            self.mp4_version.lock().unwrap().get_or_insert(Mp4Version {
                size,
                tag: Some(tag),
            });
        }
    }

    async fn fetch_mp4_block(
        &self,
        backend: &Backend,
        offset: u64,
        known: Option<Mp4Version>,
    ) -> Result<(Vec<u8>, Mp4Version)> {
        let end = offset.saturating_add(BLOCK - 1);
        let part = self.part(VIDEO)?;
        let response = backend
            .download_upstream(
                &part.upstream,
                range_headers(
                    offset,
                    end,
                    known.as_ref().and_then(|version| version.tag.as_deref()),
                ),
            )
            .await?;
        let size = parse_span(&response, offset, end)?;
        if offset.checked_add(response.body().len() as u64) != Some(end.saturating_add(1).min(size))
        {
            return Err("Источник вернул неполный блок MP4.".into());
        }
        let tag = response
            .headers()
            .get(header::ETAG)
            .and_then(|value| value.to_str().ok())
            .filter(|value| value.starts_with('"'))
            .map(str::to_owned);
        let version = Mp4Version { size, tag };
        {
            let mut previous = self.mp4_version.lock().unwrap();
            if previous
                .as_ref()
                .is_some_and(|previous| previous != &version)
            {
                return Err("Файл MP4 изменился во время скачивания.".into());
            }
            *previous = Some(version.clone());
        }
        let bytes = response.into_body();
        Ok((bytes, version))
    }

    async fn mp4_response(
        self: &Arc<Self>,
        backend: &Backend,
        range: Option<&str>,
        method: Method,
    ) -> Result<Response<Vec<u8>>> {
        let requested = range
            .and_then(|range| range.strip_prefix("bytes="))
            .and_then(|raw| raw.split_once('-'));
        let hinted = requested
            .and_then(|(start, _)| start.parse::<u64>().ok())
            .map_or(0, |start| start - start % BLOCK);
        let size = self
            .mp4_version
            .lock()
            .unwrap()
            .as_ref()
            .map(|version| version.size);
        let first = if size.is_none() {
            Some(self.mp4_block(backend, hinted, None).await?)
        } else {
            None
        };
        let size = size
            .or_else(|| first.as_ref().map(|(_, version)| version.size))
            .unwrap();
        let Some((start, wanted)) = bounds(range, size) else {
            return Ok(unsatisfiable(size));
        };
        if method == Method::HEAD {
            return Ok(local_response(
                VIDEO,
                size,
                range.is_some(),
                start,
                wanted,
                Vec::new(),
            ));
        }
        let offset = start - start % BLOCK;
        let block = match first {
            Some((bytes, _)) if offset == hinted => bytes,
            _ => self.mp4_block(backend, offset, None).await?.0,
        };
        let end = wanted.min(offset + block.len() as u64 - 1);
        let data = block[(start - offset) as usize..=(end - offset) as usize].to_vec();
        Ok(local_response(
            VIDEO,
            size,
            range.is_some() || end < wanted,
            start,
            end,
            data,
        ))
    }

    async fn save_mp4(self: &Arc<Self>, backend: &Backend, store: &Store, id: &str) -> Result<()> {
        let _guard = self
            .resources
            .lock()
            .unwrap()
            .names
            .get(VIDEO)
            .cloned()
            .ok_or("Нет потока MP4.")?;
        let _guard = _guard.lock.lock().await;
        fs::create_dir_all(&self.folder).await.map_err(disk)?;
        let target = self.folder.join(VIDEO);
        if fs::metadata(&target).await.is_ok() {
            return Ok(());
        }
        let temp = self.folder.join("video.tmp");
        let checkpoint = store.partial(id);
        tokio::select! {
            _ = self.prime_mp4_version(backend, &checkpoint) => {},
            _ = store.stopped(id) => return Err("Загрузка приостановлена.".into()),
        }
        let (_, version) = tokio::select! {
            block = self.mp4_block(backend, 0, Some(&checkpoint)) => block?,
            _ = store.stopped(id) => return Err("Загрузка приостановлена.".into()),
        };
        let tag = version.tag.as_deref().unwrap_or(&self.id);
        let revision = digest(&format!(
            "{}:{}:{}:{}:{tag}",
            self.provider, self.video_id, self.quality, version.size
        ));
        store.switch_representation(id, revision).await?;
        let mut offset = 0;
        loop {
            store.ensure_running(id).await?;
            let (bytes, version) = tokio::select! {
                bytes = self.mp4_block(backend, offset, Some(&checkpoint)) => bytes?,
                _ = store.stopped(id) => return Err("Загрузка приостановлена.".into()),
            };
            offset += bytes.len() as u64;
            store
                .progress(
                    id,
                    offset.div_ceil(BLOCK) as usize,
                    version.size.div_ceil(BLOCK) as usize,
                    offset,
                    true,
                )
                .await;
            if offset == version.size {
                break;
            }
        }
        let mut file = fs::File::create(&temp).await.map_err(disk)?;
        for offset in (0..offset).step_by(BLOCK as usize) {
            store.ensure_running(id).await?;
            let mut block = fs::File::open(self.folder.join(format!("block-{offset}")))
                .await
                .map_err(disk)?;
            tokio::io::copy(&mut block, &mut file).await.map_err(disk)?;
        }
        file.sync_all().await.map_err(disk)?;
        drop(file);
        fs::rename(temp, target).await.map_err(disk)
    }
}

fn is_disk_error(reason: &str) -> bool {
    reason.starts_with("Не удалось записать")
}

fn disk(_: std::io::Error) -> String {
    "Не удалось записать или прочитать загрузку. Проверь свободное место на диске.".into()
}

pub(crate) fn manifest_digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn digest(value: &str) -> String {
    manifest_digest(value.as_bytes())
}

async fn write(path: &Path, bytes: &[u8]) -> Result<()> {
    fs::create_dir_all(path.parent().unwrap())
        .await
        .map_err(disk)?;
    let tmp = path.with_extension(format!("{}.tmp", token()));
    let result = async {
        fs::write(&tmp, bytes).await?;
        fs::rename(&tmp, path).await
    }
    .await;
    if result.is_err() {
        let _ = fs::remove_file(&tmp).await;
    }
    result.map_err(disk)
}

async fn link_file(source: &Path, target: &Path) -> Result<()> {
    if fs::metadata(target).await.is_ok() {
        return Ok(());
    }
    fs::create_dir_all(target.parent().unwrap())
        .await
        .map_err(disk)?;
    if fs::hard_link(source, target).await.is_ok() {
        return Ok(());
    }
    if fs::metadata(target).await.is_ok() {
        return Ok(());
    }
    let temp = target.with_extension(format!("{}.tmp", token()));
    let result = async {
        fs::copy(source, &temp).await?;
        fs::rename(&temp, target).await
    }
    .await;
    if result.is_err() {
        let _ = fs::remove_file(&temp).await;
        if fs::metadata(target).await.is_ok() {
            return Ok(());
        }
    }
    result.map_err(disk)
}

async fn touch_cache(path: &Path) {
    let Some(folder) = path.parent() else { return };
    let mark = folder.join(".used");
    if fs::metadata(&mark)
        .await
        .ok()
        .and_then(|metadata| metadata.modified().ok())
        .and_then(|time| time.elapsed().ok())
        .is_none_or(|age| age > Duration::from_secs(30))
    {
        let _ = fs::write(mark, []).await;
    }
}

fn relay_path(path: &str) -> bool {
    let ids: Vec<_> = path.trim_start_matches('/').split('/').collect();
    matches!(ids.as_slice(), ["media" | "alloha", session, part] if hex(session) && hex(part))
}

fn relay_url(path: &str) -> Result<Url> {
    if !relay_path(path) {
        return Err("Неизвестный поток.".into());
    }
    Url::parse(&format!(
        "https://relay.invalid/{}",
        path.trim_start_matches('/')
    ))
    .map_err(|_| "Неизвестный поток.".into())
}

pub fn hex(id: &str) -> bool {
    id.len() == 32
        && id
            .bytes()
            .all(|c| c.is_ascii_digit() || matches!(c, b'a'..=b'f'))
}

pub fn route(path: &str) -> Option<(&str, &str)> {
    let (id, name) = path.strip_prefix("/downloads/")?.split_once('/')?;
    let (stem, ext) = name.split_once('.')?;
    (hex(id)
        && (matches!(name, INDEX | DASH | VIDEO | CAPTION)
            || (ext == "m4s"
                && stem
                    .strip_prefix('d')
                    .and_then(|stem| stem.split_once('-'))
                    .is_some_and(|(track, number)| {
                        matches!(track, "0" | "1")
                            && (number == "init"
                                || (!number.is_empty()
                                    && number.len() <= 19
                                    && number.bytes().all(|c| c.is_ascii_digit())))
                    }))
            || (!stem.is_empty()
                && stem.len() <= 4
                && stem.bytes().all(|c| c.is_ascii_digit())
                && matches!(ext, "m3u8" | "ts" | "m4s" | "mp4" | "key" | "vtt"))))
    .then_some((id, name))
}

fn range_headers(start: u64, end: u64, validator: Option<&str>) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        header::RANGE,
        format!("bytes={start}-{end}").parse().unwrap(),
    );
    if let Some(validator) = validator.and_then(|value| value.parse().ok()) {
        headers.insert(header::IF_RANGE, validator);
    }
    headers
}

fn parse_span(response: &Response<Vec<u8>>, start: u64, end: u64) -> Result<u64> {
    let size = response.body().len() as u64;
    if response.status() == StatusCode::OK
        && start == 0
        && size > 0
        && size <= end + 1
        && response
            .headers()
            .get(header::CONTENT_LENGTH)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse().ok())
            == Some(size)
    {
        return Ok(size);
    }
    if response.status() != StatusCode::PARTIAL_CONTENT {
        return Err(format!(
            "Источник не подтвердил диапазон файла (HTTP {}).",
            response.status().as_u16()
        ));
    }
    let (span, total) = response
        .headers()
        .get(header::CONTENT_RANGE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("bytes "))
        .and_then(|value| value.split_once('/'))
        .ok_or("Источник вернул неверный диапазон файла.")?;
    let (first, last) = span
        .split_once('-')
        .ok_or("Источник вернул неверный диапазон файла.")?;
    let total: u64 = total.parse().map_err(|_| "Неизвестный размер файла.")?;
    if first.parse().ok() != Some(start)
        || size == 0
        || start >= total
        || start.checked_add(size - 1) != last.parse().ok()
        || start
            .checked_add(size)
            .is_none_or(|next| next > total || next - 1 > end)
    {
        return Err("Источник вернул неверный диапазон файла.".into());
    }
    Ok(total)
}

async fn fetch_whole(backend: &Backend, uri: &str) -> Result<Vec<u8>> {
    let response = backend.download_upstream(uri, HeaderMap::new()).await?;
    if response.status() == StatusCode::OK {
        return Ok(response.into_body());
    }
    if response.status() != StatusCode::PARTIAL_CONTENT {
        return Err(format!(
            "Источник вернул HTTP {}.",
            response.status().as_u16()
        ));
    }
    let total = parse_span(&response, 0, MAX_PART - 1)?;
    if total > MAX_PART {
        return Err("Сегмент слишком большой для загрузки.".into());
    }
    let mut data = response.into_body();
    while (data.len() as u64) < total {
        let offset = data.len() as u64;
        let end = (offset + BLOCK - 1).min(total - 1);
        let (more, size) = fetch_range(backend, uri, offset, end).await?;
        if size != total {
            return Err("Сегмент изменился во время загрузки.".into());
        }
        data.extend_from_slice(&more);
    }
    Ok(data)
}

async fn fetch_range(backend: &Backend, uri: &str, start: u64, end: u64) -> Result<(Vec<u8>, u64)> {
    let response = backend
        .download_upstream(uri, range_headers(start, end, None))
        .await?;
    let total = parse_span(&response, start, end)?;
    if start + response.body().len() as u64 <= end && start + response.body().len() as u64 == total
    {
        return Err("Сегмент HLS закончился раньше указанного диапазона.".into());
    }
    Ok((response.into_body(), total))
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct DownloadSettings {
    concurrent: usize,
    cached_episodes: usize,
}

impl Default for DownloadSettings {
    fn default() -> Self {
        Self {
            concurrent: 5,
            cached_episodes: 3,
        }
    }
}

struct Inner {
    root: PathBuf,
    work: PathBuf,
    jobs: Mutex<Vec<Entry>>,
    assets: Mutex<HashMap<String, Arc<Asset>>>,
    live: Mutex<HashMap<String, Arc<Asset>>>,
    aliases: Mutex<HashMap<String, String>>,
    changed: Notify,
    settings: Mutex<DownloadSettings>,
    prefetch: Mutex<Option<(String, Arc<Notify>)>>,
    cache_checked: Mutex<Instant>,
}

fn prune_previous_work(root: &Path, keep: &Path, age: Duration) {
    let pending = root.join("work");
    if let Ok(folders) = std::fs::read_dir(pending) {
        for folder in folders.flatten() {
            if folder.path() == keep {
                continue;
            }
            if folder
                .metadata()
                .ok()
                .and_then(|stat| stat.modified().ok())
                .and_then(|time| time.elapsed().ok())
                .is_some_and(|elapsed| elapsed >= age)
            {
                let _ = std::fs::remove_dir_all(folder.path());
            }
        }
    }
}

fn recover_removals(root: &Path, jobs: &[Entry]) {
    let Ok(folders) = std::fs::read_dir(root) else {
        return;
    };
    let retained: HashSet<_> = jobs.iter().map(|job| job.id.as_str()).collect();
    for folder in folders.flatten() {
        let name = folder.file_name();
        let Some(id) = name.to_str().and_then(|name| name.strip_suffix(".removed")) else {
            continue;
        };
        if !hex(id) {
            continue;
        }
        if retained.contains(id) {
            let _ = std::fs::rename(folder.path(), root.join(id));
        } else {
            let _ = std::fs::remove_dir_all(folder.path());
        }
    }
}

fn result_ready(jobs: &[Entry], id: &str) -> bool {
    jobs.iter()
        .any(|entry| entry.id == id && entry.status == State::Ready)
}

#[derive(Clone)]
pub struct Store(Arc<Inner>);

impl Store {
    pub fn new(root: PathBuf) -> Self {
        let work = root.join("work").join(token());
        let saved = std::fs::read(root.join("jobs.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Vec<Value>>(&bytes).ok());
        let has_registry = saved.is_some();
        let mut jobs: Vec<Entry> = saved
            .unwrap_or_default()
            .into_iter()
            .filter_map(|row| serde_json::from_value::<Entry>(row).ok())
            .filter(|job| hex(&job.id))
            .collect();
        if has_registry {
            recover_removals(&root, &jobs);
        }
        for job in &mut jobs {
            if matches!(job.status, State::Downloading | State::Waiting) {
                job.status = State::Queued;
            }
        }
        let mut settings: DownloadSettings = std::fs::read(root.join("settings.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        settings.concurrent = settings.concurrent.clamp(1, 5);
        settings.cached_episodes = settings.cached_episodes.min(3);
        Self(Arc::new(Inner {
            root,
            work,
            jobs: Mutex::new(jobs),
            assets: Mutex::default(),
            live: Mutex::default(),
            aliases: Mutex::default(),
            changed: Notify::new(),
            settings: Mutex::new(settings),
            prefetch: Mutex::default(),
            cache_checked: Mutex::new(Instant::now() - Duration::from_secs(10)),
        }))
    }

    pub fn start(&self, backend: Backend) {
        let root = self.0.root.clone();
        let work = self.0.work.clone();
        tauri::async_runtime::spawn_blocking(move || {
            prune_previous_work(&root, &work, Duration::from_secs(86_400))
        });
        let store = self.clone();
        tauri::async_runtime::spawn(async move {
            store.reconcile().await;
            store.prune_cache(false).await;
            let mut workers = tokio::task::JoinSet::new();
            let mut running = HashMap::new();
            let mut next_prune = Instant::now() + RETAIN;
            loop {
                let limit = store.0.settings.lock().await.concurrent;
                let now = Instant::now();
                if now >= next_prune {
                    store.prune().await;
                    store.prune_cache(false).await;
                    next_prune = now + RETAIN;
                }
                let wake = {
                    let mut jobs = store.0.jobs.lock().await;
                    while running.len() < limit {
                        let eligible = |job: &&mut Entry| {
                            !running.values().any(|id| id == &job.id)
                                && (job.status == State::Queued
                                    || (job.status == State::Waiting
                                        && job.retry_at.is_none_or(|at| at <= now)))
                        };
                        let Some(job) = jobs
                            .iter_mut()
                            .filter(eligible)
                            .min_by_key(|job| (!job.started, job.retry_at))
                        else {
                            break;
                        };
                        job.status = State::Downloading;
                        job.error = None;
                        job.waiting_for = None;
                        let job = job.clone();
                        let id = job.id.clone();
                        let worker = store.clone();
                        let backend = backend.background_downloads();
                        let handle = workers.spawn(async move {
                            worker.run_attempt(&backend, &job).await;
                        });
                        running.insert(handle.id(), id);
                    }
                    jobs.iter()
                        .filter_map(|job| {
                            job.retry_at.filter(|at| {
                                job.status == State::Waiting && *at > now && running.len() < limit
                            })
                        })
                        .min()
                        .unwrap_or(next_prune)
                        .min(next_prune)
                };
                tokio::select! {
                    _ = store.0.changed.notified() => {},
                    result = workers.join_next_with_id(), if !workers.is_empty() => {
                        if let Some(result) = result {
                            let task = match result {
                                Ok((task, ())) => task,
                                Err(reason) => reason.id(),
                            };
                            if let Some(id) = running.remove(&task) {
                                if let Some(job) = store.0.jobs.lock().await.iter_mut()
                                    .find(|job| job.id == id && job.status == State::Downloading) {
                                    job.status = State::Queued;
                                }
                            }
                        }
                    }
                    _ = tokio::time::sleep_until(wake.into()) => {},
                }
            }
        });
    }

    async fn run_attempt(&self, backend: &Backend, job: &Entry) {
        let mut result = self.download(backend, job).await;
        if result.as_ref().is_err_and(|reason| !is_disk_error(reason))
            && self.0.jobs.lock().await.iter().any(|current| {
                current.id == job.id && current.status == State::Downloading && current.started
            })
        {
            result = self.download(backend, job).await;
        }
        let mut jobs = self.0.jobs.lock().await;
        let Some(active) = jobs
            .iter_mut()
            .find(|active| active.id == job.id && active.status == State::Downloading)
        else {
            if !jobs.iter().any(|entry| entry.id == job.id) {
                let partial = self.partial(&job.id);
                let staging = self.0.root.join(format!("{}.staging", job.id));
                let _ = fs::remove_dir_all(partial).await;
                let _ = fs::remove_dir_all(staging).await;
            }
            return;
        };
        match result {
            Ok(stream) => {
                active.status = State::Ready;
                active.stream = Some(stream);
                self.0.live.lock().await.remove(&job.id);
            }
            Err(reason) if active.started => {
                active.status = State::Waiting;
                active.retries = if active.done > job.done {
                    0
                } else {
                    active.retries.saturating_add(1)
                };
                let disk = is_disk_error(&reason);
                let seconds = if disk {
                    60
                } else {
                    2_u64.pow(active.retries.min(6)).max(2)
                };
                active.retry_at = Some(Instant::now() + Duration::from_secs(seconds));
                active.waiting_for = Some(if disk { "storage" } else { "connection" }.into());
            }
            Err(reason) => {
                active.status = State::Failed;
                active.error = Some(reason);
                self.0.live.lock().await.remove(&job.id);
            }
        }
        if self.persist(&jobs).await.is_err() {
            if let Some(job) = jobs
                .iter_mut()
                .find(|entry| entry.id == job.id && entry.status == State::Ready)
            {
                job.status = State::Waiting;
                job.started = true;
                job.retry_at = Some(Instant::now() + Duration::from_secs(60));
                job.waiting_for = Some("storage".into());
                job.error = None;
            }
        } else if result_ready(&jobs, &job.id) {
            let _ = fs::remove_dir_all(self.partial(&job.id)).await;
        }
    }

    fn partial(&self, id: &str) -> PathBuf {
        self.0.root.join("partial").join(id)
    }

    fn cache_path(&self, anime: u64, episode: &str) -> PathBuf {
        self.0
            .root
            .join("cache")
            .join(digest(&format!("{anime}:{}", episode.trim())))
    }

    async fn persist(&self, jobs: &[Entry]) -> Result<()> {
        let bytes = serde_json::to_vec(jobs).map_err(|_| "Не удалось сохранить очередь.")?;
        write(&self.0.root.join("jobs.json"), &bytes).await
    }

    async fn prune(&self) {
        self.prune_work(RETAIN).await;
    }

    async fn prune_work(&self, age: Duration) {
        let mut assets = self.0.assets.lock().await;
        // Keep assets currently used by the player or a download. Old folders are
        // pruned only after their serving tasks have released ownership.
        let expired = assets
            .iter()
            .filter_map(|(id, asset)| {
                (Arc::strong_count(asset) == 1 && asset.used.lock().unwrap().elapsed() > age)
                    .then_some(id.clone())
            })
            .collect::<Vec<_>>();
        for id in expired {
            if let Some(asset) = assets.remove(&id) {
                let _ = fs::remove_dir_all(&asset.folder).await;
            }
        }
    }

    async fn reconcile(&self) {
        let snapshot = self.0.jobs.lock().await.clone();
        let root = self.0.root.clone();
        let measured = tokio::task::spawn_blocking(move || {
            let mut sizes = HashMap::new();
            let partial = root.join("partial");
            let retained: HashSet<_> = snapshot
                .iter()
                .filter(|job| job.status != State::Ready)
                .map(|job| job.id.as_str())
                .collect();
            if let Ok(paths) = std::fs::read_dir(&partial) {
                for path in paths.flatten() {
                    if path
                        .file_name()
                        .to_str()
                        .is_some_and(|id| hex(id) && !retained.contains(id))
                    {
                        let _ = std::fs::remove_dir_all(path.path());
                    }
                }
            }
            if let Ok(paths) = std::fs::read_dir(&root) {
                for path in paths.flatten() {
                    if path
                        .file_name()
                        .to_str()
                        .and_then(|name| name.strip_suffix(".staging"))
                        .is_some_and(hex)
                    {
                        let _ = std::fs::remove_dir_all(path.path());
                    }
                }
            }
            for job in snapshot {
                let folder = if job.status == State::Ready {
                    root.join(&job.id)
                } else {
                    root.join("partial").join(&job.id)
                };
                let started = folder.join(".started").is_file();
                let journal = std::fs::read(root.join(&job.id).join(".ready.json"))
                    .ok()
                    .and_then(|bytes| serde_json::from_slice::<Ready>(&bytes).ok());
                let final_bytes = journal
                    .as_ref()
                    .map(|_| directory_bytes(&root.join(&job.id), &mut HashSet::new()));
                sizes.insert(
                    job.id,
                    (
                        directory_bytes(&folder, &mut HashSet::new()),
                        started,
                        journal.zip(final_bytes),
                    ),
                );
            }
            sizes
        })
        .await;
        if let Ok(sizes) = measured {
            for job in self.0.jobs.lock().await.iter_mut() {
                if let Some((bytes, started, journal)) = sizes.get(&job.id) {
                    job.saved_bytes = *bytes;
                    job.started |= *started;
                    if let Some((stream, final_bytes)) = journal {
                        job.status = State::Ready;
                        job.stream = Some(stream.clone());
                        job.actual_quality = Some(stream.quality);
                        job.saved_bytes = *final_bytes;
                    }
                }
            }
        }
    }

    async fn prune_cache(&self, clear: bool) {
        let limit = if clear {
            0
        } else {
            self.0.settings.lock().await.cached_episodes
        };
        let protected: HashSet<_> = {
            let assets = self.0.assets.lock().await;
            assets
                .values()
                .filter_map(|asset| {
                    if clear || limit == 0 {
                        asset.cache.lock().unwrap().take();
                        None
                    } else if Arc::strong_count(asset) > 1
                        || asset.used.lock().unwrap().elapsed() < Duration::from_secs(30)
                    {
                        asset.cache_folder()
                    } else {
                        None
                    }
                })
                .collect()
        };
        let root = self.0.root.join("cache");
        let _ = tokio::task::spawn_blocking(move || {
            let Ok(entries) = std::fs::read_dir(&root) else {
                return;
            };
            let mut entries: Vec<_> = entries
                .flatten()
                .filter_map(|entry| {
                    let path = entry.path();
                    let metadata = entry.metadata().ok()?;
                    metadata.is_dir().then(|| {
                        let touched = std::fs::metadata(path.join(".used"))
                            .and_then(|value| value.modified());
                        (touched.or_else(|_| metadata.modified()).ok(), path)
                    })
                })
                .collect();
            entries.sort_by(|a, b| b.0.cmp(&a.0));
            let mut retained = entries
                .iter()
                .filter(|(_, path)| protected.contains(path))
                .count();
            let mut bytes = entries
                .iter()
                .filter(|(_, path)| protected.contains(path))
                .map(|(_, path)| directory_bytes(path, &mut HashSet::new()))
                .fold(0, u64::saturating_add);
            let low = free_disk(&root).is_some_and(|free| free < CACHE_FREE);
            for (_, path) in entries {
                if limit > 0 && protected.contains(&path) {
                    continue;
                }
                let size = directory_bytes(&path, &mut HashSet::new());
                if retained < limit && !low && bytes.saturating_add(size) <= CACHE_BYTES {
                    retained += 1;
                    bytes += size;
                } else {
                    let _ = std::fs::remove_dir_all(path);
                }
            }
        })
        .await;
    }

    async fn prefetch_episode(&self, backend: &Backend, request: PrefetchRequest) -> Result<()> {
        if self.0.settings.lock().await.cached_episodes < 2
            || request.episode.len() > 32
            || request.ticket.len() > 64
            || free_disk(&self.0.root).is_some_and(|free| free < CACHE_FREE)
        {
            return Ok(());
        }
        if self
            .ready_copy(&request.candidates, request.quality)
            .await
            .is_some()
        {
            return Ok(());
        }
        let background = backend.background_downloads();
        let backend = &background;
        let cancel = Arc::new(Notify::new());
        {
            let mut active = self.0.prefetch.lock().await;
            if let Some((_, previous)) = active.replace((request.ticket.clone(), cancel.clone())) {
                previous.notify_one();
            }
        }
        let prefetch = async {
            let resolution = backend
                .resolve_download(&request.candidates, request.quality)
                .await?;
            let result = self
                .wrap_episode(resolution, Some((request.anime_id, &request.episode)))
                .await;
            let asset = self.chosen_asset(&result, request.quality).await?;
            if asset.entry == VIDEO {
                asset.mp4_block(backend, 0, None).await?;
            } else if asset.entry == DASH {
                asset.bytes(backend, DASH, None).await?;
                let mut parts: Vec<_> = asset
                    .resources
                    .lock()
                    .unwrap()
                    .names
                    .keys()
                    .filter(|name| name.ends_with(".m4s"))
                    .cloned()
                    .collect();
                parts.sort_by_key(|name| {
                    let sequence = name
                        .split_once('-')
                        .and_then(|(_, part)| part.strip_suffix(".m4s"));
                    (
                        sequence
                            .and_then(|part| part.parse::<u64>().ok())
                            .unwrap_or(0),
                        name.clone(),
                    )
                });
                for name in parts.iter().take(6) {
                    asset.bytes(backend, name, None).await?;
                }
            } else {
                let (_, media) = self.hls_files(backend, None, &asset).await?;
                for name in media.iter().take(6) {
                    asset.bytes(backend, name, None).await?;
                }
            }
            Ok(())
        };
        let result = tokio::select! {
            result = tokio::time::timeout(Duration::from_secs(45), prefetch) => {
                result.unwrap_or_else(|_| Err("Предзагрузка прервалась.".into()))
            },
            _ = cancel.notified() => Ok(()),
        };
        let mut active = self.0.prefetch.lock().await;
        if active
            .as_ref()
            .is_some_and(|(ticket, _)| ticket == &request.ticket)
        {
            active.take();
        }
        drop(active);
        self.prune_cache(false).await;
        result
    }

    async fn asset(
        &self,
        provider: &str,
        video_id: u64,
        quality: u32,
        upstream: &str,
        kind: Kind,
        caption: Option<&str>,
        fallback: Option<Arc<Asset>>,
    ) -> Result<Arc<Asset>> {
        let upstream = relay_url(upstream)?.path().to_owned();
        self.prune().await;
        let entry = match kind {
            Kind::Mp4 => VIDEO,
            Kind::Dash => DASH,
            _ => INDEX,
        };
        let mut assets = self.0.assets.lock().await;
        if let Some(existing) = assets.values().find(|asset| {
            asset.video_id == video_id
                && asset.quality == quality
                && asset.entry == entry
                && asset
                    .part(entry)
                    .is_ok_and(|part| part.upstream == upstream)
        }) {
            *existing.used.lock().unwrap() = Instant::now();
            return Ok(existing.clone());
        }
        let id = token();
        let asset = Arc::new(Asset {
            folder: self.0.work.join(&id),
            cache: StdMutex::default(),
            id: id.clone(),
            provider: provider.to_owned(),
            video_id,
            quality,
            entry,
            caption: caption.is_some(),
            skips: StdMutex::default(),
            used: StdMutex::new(Instant::now()),
            resources: StdMutex::default(),
            versions: StdMutex::default(),
            blocks: StdMutex::default(),
            mp4_version: StdMutex::default(),
            fallback,
        });
        asset.add(
            Some(entry),
            Part {
                upstream,
                kind,
                range: None,
            },
        )?;
        if let Some(raw) = caption {
            asset.add(
                Some(CAPTION),
                Part {
                    upstream: relay_url(raw)?.path().into(),
                    kind: Kind::Caption,
                    range: None,
                },
            )?;
        }
        assets.insert(id, asset.clone());
        Ok(asset)
    }

    pub async fn wrap_episode(&self, mut result: Value, episode: Option<(u64, &str)>) -> Value {
        let cache = if self.0.settings.lock().await.cached_episodes > 0 {
            episode.map(|(anime, episode)| self.cache_path(anime, episode))
        } else {
            None
        };
        let provider = result["provider"].as_str().unwrap_or_default().to_owned();
        let Some(video_id) = result["videoId"].as_u64() else {
            return result;
        };
        if !matches!(provider.as_str(), "CVH" | "Alloha" | "Kodik" | "Aksor")
            || result["relay"] != true
        {
            return result;
        }
        let caption = result["caption"]["url"].as_str().map(str::to_owned);
        let skips = result["skips"].clone();
        let reserves = result["downloadMp4"].take();
        let Some(streams) = result["streams"].as_array_mut() else {
            return result;
        };
        for stream in streams {
            let Some(quality) = stream["quality"]
                .as_u64()
                .and_then(|value| u32::try_from(value).ok())
            else {
                continue;
            };
            let Some(raw) = stream["url"].as_str().map(str::to_owned) else {
                continue;
            };
            let kind = match stream["type"].as_str() {
                Some("hls") => Kind::Playlist,
                Some("mp4") => Kind::Mp4,
                Some("dash") => Kind::Dash,
                _ => continue,
            };
            let mut fallback = None;
            if kind == Kind::Playlist {
                let reserve = reserves
                    .as_array()
                    .and_then(|values| values.iter().find(|value| value["quality"] == quality));
                let reserve = if stream["fallback"]["type"] == "mp4" {
                    Some(&stream["fallback"])
                } else {
                    reserve
                };
                if let Some(raw) = reserve.and_then(|value| value["url"].as_str()) {
                    fallback = self
                        .asset(
                            &provider,
                            video_id,
                            quality,
                            raw,
                            Kind::Mp4,
                            caption.as_deref(),
                            None,
                        )
                        .await
                        .ok();
                    if let Some(reserve) = &fallback {
                        reserve.add_skips(&skips);
                        if cache.is_some() {
                            *reserve.cache.lock().unwrap() = cache.clone();
                        }
                    }
                    if let Some(reserve) = fallback.as_ref().filter(|_| provider == "Kodik") {
                        stream["fallback"]["url"] =
                            format!("downloads/{}/{}", reserve.id, reserve.entry).into();
                    }
                }
            }
            if let Ok(asset) = self
                .asset(
                    &provider,
                    video_id,
                    quality,
                    &raw,
                    kind,
                    caption.as_deref(),
                    fallback,
                )
                .await
            {
                asset.add_skips(&skips);
                if cache.is_some() {
                    *asset.cache.lock().unwrap() = cache.clone();
                }
                stream["url"] = format!("downloads/{}/{}", asset.id, asset.entry).into();
                if stream["legacyUrl"].is_null() {
                    stream["legacyUrl"] = raw.into();
                }
                if asset.caption {
                    stream["captionUrl"] = format!("downloads/{}/{CAPTION}", asset.id).into();
                }
            }
        }
        result
    }

    async fn enqueue(&self, requests: Vec<Request>) -> Result<Vec<Entry>> {
        if requests.is_empty() || requests.len() > LIMIT {
            return Err(format!("Выбери от 1 до {LIMIT} серий."));
        }
        for request in &requests {
            if request.anime_id == 0
                || request.title.trim().is_empty()
                || request.title.len() > 1024
                || request.anime.as_ref().is_some_and(|anime| {
                    anime.poster.as_ref().is_some_and(|url| url.len() > 4096)
                        || anime.kind.as_ref().is_some_and(|kind| kind.len() > 256)
                })
                || request.episode.trim().is_empty()
                || request.episode.len() > 32
                || request.preview.as_ref().is_some_and(|url| url.len() > 4096)
                || request.voice.trim().is_empty()
                || request.voice.len() > 512
                || request.quality == 0
                || request.quality > 4320
                || request.candidates.is_empty()
                || request.candidates.len() > 12
                || request.markers.len() > 12
                || request.candidates.iter().any(|v| {
                    v.episode != request.episode
                        || v.dubbing != request.voice
                        || v.url.len() > 4096
                        || !providers::provider_url(&v.url).is_ok_and(|(_, name)| {
                            matches!(name, "cvh" | "alloha" | "kodik" | "aksor")
                        })
                })
            {
                return Err("Выбери серию и озвучку из доступных источников.".into());
            }
        }
        let mut jobs = self.0.jobs.lock().await;
        let mut next = jobs.clone();
        for mut request in requests {
            request.markers.retain(|video_id, markers| {
                if !request
                    .candidates
                    .iter()
                    .any(|candidate| candidate.video_id == *video_id)
                {
                    return false;
                }
                *markers = crate::skips::provider_skips(&serde_json::json!({"skips": markers}), "");
                markers.as_object().is_some_and(|value| !value.is_empty())
            });
            if next.iter().any(|job| {
                job.request.anime_id == request.anime_id
                    && job.request.episode == request.episode
                    && job.request.voice == request.voice
                    && job.request.quality == request.quality
            }) {
                continue;
            }
            if next.len() >= LIMIT {
                return Err("В очереди слишком много серий.".into());
            }
            next.push(Entry {
                id: token(),
                request,
                status: State::Queued,
                done: 0,
                total: 0,
                error: None,
                stream: None,
                actual_quality: None,
                started: false,
                saved_bytes: 0,
                representation: None,
                retry_at: None,
                retries: 0,
                waiting_for: None,
            });
        }
        self.persist(&next).await?;
        *jobs = next;
        self.0.changed.notify_one();
        Ok(jobs.clone())
    }

    async fn change(&self, id: &str, action: &str) -> Result<Vec<Entry>> {
        let mut jobs = self.0.jobs.lock().await;
        let mut next = jobs.clone();
        let index = next
            .iter()
            .position(|job| job.id == id)
            .ok_or("Загрузка не найдена.")?;
        let job = &mut next[index];
        match action {
            "pause"
                if matches!(
                    job.status,
                    State::Queued | State::Downloading | State::Waiting
                ) =>
            {
                job.status = State::Paused
            }
            "retry" if matches!(job.status, State::Paused | State::Failed) => {
                job.status = State::Queued;
                job.error = None;
                job.retry_at = None;
                job.waiting_for = None;
            }
            "cancel" if job.status == State::Ready => {
                return Err("Серия уже скачана и доступна офлайн.".into());
            }
            "cancel" | "remove" => {
                return self.remove_entries(&mut jobs, HashSet::from([id])).await;
            }
            _ => return Err("Действие недоступно для этой загрузки.".into()),
        }
        self.persist(&next).await?;
        *jobs = next;
        self.0.changed.notify_one();
        Ok(jobs.clone())
    }

    async fn remove_entries(
        &self,
        jobs: &mut Vec<Entry>,
        ids: HashSet<&str>,
    ) -> Result<Vec<Entry>> {
        let next: Vec<_> = jobs
            .iter()
            .filter(|job| !ids.contains(job.id.as_str()))
            .cloned()
            .collect();
        if next.len() == jobs.len() {
            return Ok(jobs.clone());
        }

        // Hide the files before committing the new registry. Restore them if the commit fails.
        let mut staged = Vec::new();
        let commit = async {
            for job in jobs.iter().filter(|job| ids.contains(job.id.as_str())) {
                let path = self.0.root.join(&job.id);
                let removed = self.0.root.join(format!("{}.removed", job.id));
                match fs::rename(&path, &removed).await {
                    Ok(()) => staged.push((path, removed)),
                    Err(reason) if reason.kind() == ErrorKind::NotFound => {}
                    Err(reason) => return Err(disk(reason)),
                }
            }
            self.persist(&next).await
        }
        .await;
        if let Err(reason) = commit {
            for (path, removed) in staged {
                let _ = fs::rename(removed, path).await;
            }
            return Err(reason);
        }
        *jobs = next;
        self.0
            .live
            .lock()
            .await
            .retain(|id, _| !ids.contains(id.as_str()));
        self.0
            .aliases
            .lock()
            .await
            .retain(|_, ready| !ids.contains(ready.as_str()));
        let partials = ids
            .iter()
            .flat_map(|id| [self.partial(id), self.0.root.join(format!("{id}.staging"))]);
        for path in partials {
            let _ = fs::remove_dir_all(path).await;
        }
        for (_, removed) in staged {
            let _ = fs::remove_dir_all(removed).await;
        }
        self.0.changed.notify_one();
        Ok(jobs.clone())
    }

    async fn switch_representation(&self, id: &str, revision: String) -> Result<()> {
        let mut jobs = self.0.jobs.lock().await;
        let job = jobs
            .iter_mut()
            .find(|job| job.id == id && job.status == State::Downloading)
            .ok_or("Загрузка приостановлена.")?;
        if job
            .representation
            .as_ref()
            .is_some_and(|old| old != &revision)
        {
            match fs::remove_dir_all(self.partial(id)).await {
                Ok(()) => {}
                Err(reason) if reason.kind() == ErrorKind::NotFound => {}
                Err(reason) => return Err(disk(reason)),
            }
            job.done = 0;
            job.saved_bytes = 0;
            job.total = 0;
        }
        job.representation = Some(revision);
        Ok(())
    }

    async fn progress(&self, id: &str, done: usize, total: usize, bytes: u64, media: bool) {
        let mut jobs = self.0.jobs.lock().await;
        if let Some(job) = jobs
            .iter_mut()
            .find(|job| job.id == id && job.status == State::Downloading)
        {
            let first = !job.started && media;
            job.started |= media;
            job.done = job.done.max(done);
            job.total = total;
            job.saved_bytes = job.saved_bytes.max(bytes);
            if first {
                let _ = write(&self.partial(id).join(".started"), &[]).await;
                let _ = self.persist(&jobs).await;
            }
        }
    }

    async fn ensure_running(&self, id: &str) -> Result<()> {
        if self
            .0
            .jobs
            .lock()
            .await
            .iter()
            .any(|job| job.id == id && job.status == State::Downloading)
        {
            Ok(())
        } else {
            Err("Загрузка приостановлена.".into())
        }
    }

    async fn stopped(&self, id: &str) {
        while self.ensure_running(id).await.is_ok() {
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }

    async fn from_active(&self, request: &Request) -> Option<Arc<Asset>> {
        let (asset, resource) = route(request.active.as_deref()?)?;
        let assets = self.0.assets.lock().await;
        let asset = assets.get(asset)?;
        (asset.entry == resource
            && asset.quality == request.quality
            && request
                .candidates
                .iter()
                .any(|candidate| candidate.video_id == asset.video_id))
        .then(|| asset.clone())
    }

    async fn recent_asset(&self, request: &Request) -> Option<Arc<Asset>> {
        let assets = self.0.assets.lock().await;
        assets
            .values()
            .filter(|asset| {
                asset.quality == request.quality
                    && asset.used.lock().unwrap().elapsed() < Duration::from_secs(90)
                    && request
                        .candidates
                        .iter()
                        .any(|candidate| candidate.video_id == asset.video_id)
            })
            .max_by_key(|asset| *asset.used.lock().unwrap())
            .cloned()
    }

    pub(crate) async fn ready_copy(&self, candidates: &[Candidate], quality: u32) -> Option<Ready> {
        let mut ready: Vec<_> = self
            .0
            .jobs
            .lock()
            .await
            .iter()
            .filter(|job| job.status == State::Ready)
            .filter_map(|job| {
                job.stream.as_ref().filter(|stream| {
                    candidates.iter().any(|candidate| {
                        candidate.video_id != 0
                            && candidate.video_id == stream.video_id
                            && candidate.episode == job.request.episode
                    })
                })
            })
            .cloned()
            .collect();
        ready.sort_by_key(|stream| (stream.quality > quality, stream.quality.abs_diff(quality)));
        for stream in ready {
            let path = format!("/{}", stream.entry);
            if let Some((id, name)) = route(&path) {
                if fs::metadata(self.0.root.join(id).join(name))
                    .await
                    .is_ok_and(|file| file.is_file())
                {
                    return Some(stream);
                }
            }
        }
        None
    }

    pub async fn playable(&self, candidates: &[Candidate], quality: u32) -> Option<Value> {
        if let Some(stream) = self.ready_copy(candidates, quality).await {
            let mut result = playback_result(
                &stream.provider,
                stream.video_id,
                stream.quality,
                &stream.entry,
                stream.caption,
            );
            result["streams"][0]["offline"] = true.into();
            result["skips"] = stream.skips;
            return Some(result);
        }
        let jobs = self.0.jobs.lock().await;
        let running = jobs.iter().find(|job| {
            (job.request.quality == quality || job.actual_quality == Some(quality))
                && job.status == State::Downloading
                && job
                    .request
                    .candidates
                    .iter()
                    .any(|expected| candidates.contains(expected))
        });
        if let Some(job) = running {
            if let Some(asset) = self.0.live.lock().await.get(&job.id).filter(|asset| {
                candidates
                    .iter()
                    .any(|candidate| candidate.video_id == asset.video_id)
            }) {
                let path = format!("downloads/{}", asset.id);
                let entry = format!("{path}/{}", asset.entry);
                let mut result = playback_result(
                    &asset.provider,
                    asset.video_id,
                    asset.quality,
                    &entry,
                    asset.caption.then(|| format!("{path}/{CAPTION}")),
                );
                result["skips"] = asset.skips.lock().unwrap().clone();
                return Some(result);
            }
        }
        None
    }

    async fn chosen_asset(&self, result: &Value, quality: u32) -> Result<Arc<Asset>> {
        let chosen = result["streams"].as_array().and_then(|streams| {
            streams
                .iter()
                .filter_map(|stream| {
                    let height = u32::try_from(stream["quality"].as_u64()?).ok()?;
                    let format = download_format(stream["type"].as_str()?);
                    (height <= quality && stream["url"].as_str()?.starts_with("downloads/"))
                        .then_some(((height, format), stream))
                })
                .max_by_key(|(rank, _)| *rank)
                .map(|(_, stream)| stream)
        });
        let (id, _) = chosen
            .and_then(|stream| stream["url"].as_str())
            .and_then(|path| {
                route(&format!("/{path}")).map(|(id, name)| (id.to_owned(), name.to_owned()))
            })
            .ok_or("Источник не предоставил выбранное качество для загрузки.")?;
        self.0
            .assets
            .lock()
            .await
            .get(&id)
            .cloned()
            .ok_or_else(|| "Стрим уже недоступен.".into())
    }

    async fn refresh_asset(&self, asset: &Asset) -> Result<Arc<Asset>> {
        let id = token();
        let refreshed = Arc::new(Asset {
            folder: self.0.work.join(&id),
            id: id.clone(),
            provider: asset.provider.clone(),
            video_id: asset.video_id,
            quality: asset.quality,
            entry: asset.entry,
            caption: asset.caption,
            skips: StdMutex::new(asset.skips.lock().unwrap().clone()),
            cache: StdMutex::new(asset.cache_folder()),
            used: StdMutex::new(Instant::now()),
            resources: StdMutex::default(),
            versions: StdMutex::default(),
            blocks: StdMutex::default(),
            mp4_version: StdMutex::default(),
            fallback: asset.fallback.clone(),
        });
        refreshed.add(Some(asset.entry), asset.part(asset.entry)?)?;
        if asset.caption {
            refreshed.add(Some(CAPTION), asset.part(CAPTION)?)?;
        }
        self.0.assets.lock().await.insert(id, refreshed.clone());
        Ok(refreshed)
    }

    async fn download(&self, backend: &Backend, job: &Entry) -> Result<Ready> {
        if let Ok(bytes) = fs::read(self.0.root.join(&job.id).join(".ready.json")).await {
            if let Ok(stream) = serde_json::from_slice::<Ready>(&bytes) {
                if route(&format!("/{}", stream.entry)).is_some_and(|(id, _)| id == job.id) {
                    return Ok(stream);
                }
            }
        }
        let live = self.0.live.lock().await.get(&job.id).cloned();
        let mut asset = if let Some(active) = live.filter(|_| job.retries == 0) {
            active
        } else if let Some(active) = self
            .from_active(&job.request)
            .await
            .filter(|_| !job.started)
        {
            active
        } else if let Some(active) = self
            .recent_asset(&job.request)
            .await
            .filter(|_| !job.started)
        {
            active
        } else {
            if job.started {
                backend
                    .forget_download_sources(&job.request.candidates)
                    .await;
            }
            let resolution = backend.resolve_download(&job.request.candidates, job.request.quality);
            let result = tokio::select! {
                resolved = tokio::time::timeout(Duration::from_secs(30), resolution) => {
                    resolved.map_err(|_| "Источник не ответил вовремя.")??
                }
                _ = self.stopped(&job.id) => return Err("Загрузка приостановлена.".into()),
            };
            let result = self
                .wrap_episode(result, Some((job.request.anime_id, &job.request.episode)))
                .await;
            let chosen = self.chosen_asset(&result, job.request.quality).await?;
            if job.retries > 0 {
                self.refresh_asset(&chosen).await?
            } else {
                chosen
            }
        };
        {
            let mut jobs = self.0.jobs.lock().await;
            if let Some(current) = jobs.iter_mut().find(|current| current.id == job.id) {
                current.actual_quality = Some(asset.quality);
            }
        }
        self.0
            .live
            .lock()
            .await
            .insert(job.id.clone(), asset.clone());
        let files = if asset.entry == INDEX {
            match self.save_hls(backend, job, &asset).await {
                Ok(files) => files,
                Err(reason) => {
                    self.ensure_running(&job.id).await?;
                    if is_disk_error(&reason)
                        || self
                            .0
                            .jobs
                            .lock()
                            .await
                            .iter()
                            .any(|current| current.id == job.id && current.started)
                    {
                        return Err(reason);
                    }
                    let fallback = asset.fallback.clone().ok_or(reason)?;
                    fallback.add_skips(&asset.skips.lock().unwrap());
                    asset = fallback;
                    self.0
                        .live
                        .lock()
                        .await
                        .insert(job.id.clone(), asset.clone());
                    asset.save_mp4(backend, self, &job.id).await?;
                    vec![VIDEO.to_owned()]
                }
            }
        } else if asset.entry == DASH {
            self.save_part(backend, job, &asset, DASH).await?;
            self.switch_representation(&job.id, asset.representation())
                .await?;
            let parts = {
                let resources = asset.resources.lock().unwrap();
                let mut parts: Vec<_> = resources
                    .names
                    .keys()
                    .filter(|name| *name != DASH && *name != CAPTION)
                    .cloned()
                    .collect();
                parts.sort_by_key(|name| {
                    let part = name
                        .split_once('-')
                        .and_then(|(_, value)| value.strip_suffix(".m4s"));
                    (
                        part.and_then(|number| number.parse::<u64>().ok())
                            .unwrap_or(0),
                        name.clone(),
                    )
                });
                parts
            };
            let mut files = vec![DASH.to_owned()];
            self.save_parts(backend, job, &asset, parts, &mut files)
                .await?;
            files
        } else {
            asset.save_mp4(backend, self, &job.id).await?;
            vec![VIDEO.to_owned()]
        };
        let mut files = files;
        if asset.caption {
            self.save_part(backend, job, &asset, CAPTION).await?;
            files.push(CAPTION.to_owned());
        }
        self.ensure_running(&job.id).await?;
        let ready = self.0.root.join(&job.id);
        let staging = self.0.root.join(format!("{}.staging", job.id));
        let _ = fs::remove_dir_all(&staging).await;
        fs::create_dir_all(&staging).await.map_err(disk)?;
        let mut saved_bytes = 0_u64;
        for name in &files {
            let source = asset.filename(name)?;
            saved_bytes =
                saved_bytes.saturating_add(fs::metadata(&source).await.map_err(disk)?.len());
            let target = staging.join(name);
            if fs::hard_link(&source, &target).await.is_err() {
                fs::copy(&source, &target).await.map_err(disk)?;
            }
        }
        let root = format!("downloads/{}", job.id);
        let stream = Ready {
            provider: asset.provider.clone(),
            video_id: asset.video_id,
            quality: asset.quality,
            entry: format!("{root}/{}", asset.entry),
            caption: asset.caption.then(|| format!("{root}/{CAPTION}")),
            skips: crate::skips::provider_skips(
                &serde_json::json!({
                    "skips": job.request.markers.get(&asset.video_id),
                    "skip": *asset.skips.lock().unwrap(),
                }),
                "",
            ),
        };

        let journal = serde_json::to_vec(&stream).map_err(|_| "Не удалось сохранить загрузку.")?;
        write(&staging.join(".ready.json"), &journal).await?;
        let mut jobs = self.0.jobs.lock().await;
        let Some(active) = jobs
            .iter_mut()
            .find(|active| active.id == job.id && active.status == State::Downloading)
        else {
            let _ = fs::remove_dir_all(staging).await;
            return Err("Загрузка приостановлена.".into());
        };
        if let Err(reason) = fs::remove_dir_all(&ready).await {
            if reason.kind() != ErrorKind::NotFound {
                return Err(disk(reason));
            }
        }
        fs::rename(&staging, &ready).await.map_err(disk)?;
        active.saved_bytes = saved_bytes;
        self.0
            .aliases
            .lock()
            .await
            .insert(asset.id.clone(), job.id.clone());
        drop(jobs);
        Ok(stream)
    }

    async fn save_hls(
        &self,
        backend: &Backend,
        job: &Entry,
        asset: &Arc<Asset>,
    ) -> Result<Vec<String>> {
        let (mut files, media) = self.hls_files(backend, Some(job), asset).await?;
        self.switch_representation(&job.id, asset.representation())
            .await?;
        self.save_parts(backend, job, asset, media, &mut files)
            .await?;
        Ok(files)
    }

    async fn hls_files(
        &self,
        backend: &Backend,
        job: Option<&Entry>,
        asset: &Arc<Asset>,
    ) -> Result<(Vec<String>, Vec<String>)> {
        let mut playlists = vec![INDEX.to_owned()];
        let mut visited = HashSet::new();
        let mut files = Vec::new();
        let mut media = Vec::new();
        while let Some(name) = playlists.pop() {
            if let Some(job) = job {
                self.ensure_running(&job.id).await?;
            }
            if !visited.insert(name.clone()) {
                continue;
            }
            if visited.len() > 32 {
                return Err("В HLS слишком много вложенных плейлистов.".into());
            }
            let bytes = match job {
                Some(job) => self.save_part(backend, job, asset, &name).await?,
                None => asset.bytes(backend, &name, None).await?,
            };
            let text = std::str::from_utf8(&bytes).map_err(|_| "Некорректный плейлист HLS.")?;
            if !text
                .lines()
                .any(|line| line.starts_with("#EXT-X-STREAM-INF:"))
                && !text
                    .lines()
                    .any(|line| matches!(line, "#EXT-X-ENDLIST" | "#EXT-X-PLAYLIST-TYPE:VOD"))
            {
                return Err("Источник не подтвердил, что плейлист содержит всю серию.".into());
            }
            files.push(name);
            for line in text.lines() {
                let child = if line.starts_with('#') {
                    line.split_once("URI=\"")
                        .and_then(|(_, tail)| tail.split_once('"'))
                        .map(|(name, _)| name)
                } else if !line.is_empty() {
                    Some(line)
                } else {
                    None
                };
                let Some(child) = child else { continue };
                if asset.part(child)?.kind.is_playlist() {
                    playlists.push(child.to_owned());
                } else if visited.insert(child.to_owned()) {
                    media.push(child.to_owned());
                }
            }
        }
        Ok((files, media))
    }

    async fn save_part(
        &self,
        backend: &Backend,
        job: &Entry,
        asset: &Arc<Asset>,
        name: &str,
    ) -> Result<Vec<u8>> {
        let checkpoint = self.partial(&job.id);
        tokio::select! {
            bytes = asset.bytes(backend, name, Some(&checkpoint)) => bytes,
            _ = self.stopped(&job.id) => Err("Загрузка приостановлена.".into()),
        }
    }

    async fn save_parts(
        &self,
        backend: &Backend,
        job: &Entry,
        asset: &Arc<Asset>,
        media: Vec<String>,
        files: &mut Vec<String>,
    ) -> Result<()> {
        let total = media.len();
        self.progress(&job.id, 0, total, 0, false).await;
        let mut bytes = 0;
        for (index, name) in media.into_iter().enumerate() {
            self.ensure_running(&job.id).await?;
            let part = self.save_part(backend, job, asset, &name).await?;
            bytes += part.len() as u64;
            let started = !name.ends_with("-init.m4s")
                && matches!(asset.part(&name)?.kind, Kind::Segment | Kind::Fragment);
            files.push(name);
            self.progress(&job.id, index + 1, total, bytes, started)
                .await;
        }
        Ok(())
    }

    pub async fn serve(
        &self,
        backend: &Backend,
        id: &str,
        name: &str,
        method: Method,
        headers: &HeaderMap,
    ) -> Response<Vec<u8>> {
        let range = headers
            .get(header::RANGE)
            .and_then(|value| value.to_str().ok());
        let alias = self.0.aliases.lock().await.get(id).cloned();
        if let Some(response) = read_file(
            &self.0.root.join(alias.as_deref().unwrap_or(id)).join(name),
            name,
            range,
            &method,
        )
        .await
        {
            return response;
        }
        let asset = self.0.assets.lock().await.get(id).cloned();
        let Some(asset) = asset else {
            return error(StatusCode::NOT_FOUND, "Загрузка не найдена.");
        };
        if let Ok(mut checked) = self.0.cache_checked.try_lock() {
            if asset.cache_folder().is_some() && checked.elapsed() >= Duration::from_secs(5) {
                *checked = Instant::now();
                let store = self.clone();
                tokio::spawn(async move { store.prune_cache(false).await });
            }
        }
        if asset.entry == VIDEO && name == VIDEO {
            *asset.used.lock().unwrap() = Instant::now();
            if let Some(response) = read_file(&asset.folder.join(name), name, range, &method).await
            {
                return response;
            }
            return asset
                .mp4_response(backend, range, method)
                .await
                .unwrap_or_else(|reason| error(StatusCode::BAD_GATEWAY, &reason));
        }
        match asset.bytes(backend, name, None).await {
            Ok(data) => {
                let size = data.len() as u64;
                let Some((start, end)) = bounds(range, size) else {
                    return unsatisfiable(size);
                };
                let data = if method == Method::HEAD {
                    Vec::new()
                } else if start == 0 && end + 1 == size {
                    data
                } else {
                    data[start as usize..=end as usize].to_vec()
                };
                local_response(name, size, range.is_some(), start, end, data)
            }
            Err(reason) => error(StatusCode::BAD_GATEWAY, &reason),
        }
    }
}

fn playback_result(
    provider: &str,
    id: u64,
    quality: u32,
    entry: &str,
    caption: Option<String>,
) -> Value {
    let kind = if entry.ends_with(".m3u8") {
        "hls"
    } else if entry.ends_with(".mpd") {
        "dash"
    } else {
        "mp4"
    };
    let mut result = serde_json::json!({"provider":provider,"videoId":id,"duration":0,"relay":true,
        "streams":[{"quality":quality,"url":entry,"type":kind}]});
    if let Some(caption) = caption {
        result["caption"] = serde_json::json!({"url":caption,"label":"Субтитры","language":"ru"});
    }
    result
}

async fn read_file(
    path: &Path,
    name: &str,
    range: Option<&str>,
    method: &Method,
) -> Option<Response<Vec<u8>>> {
    let mut file = fs::File::open(path).await.ok()?;
    let size = file.metadata().await.ok()?.len();
    let Some((start, wanted)) = bounds(range, size) else {
        return Some(unsatisfiable(size));
    };
    let end = if name == VIDEO && *method != Method::HEAD {
        wanted.min(start.saturating_add(BLOCK - 1))
    } else {
        wanted
    };
    let mut data = Vec::new();
    if *method != Method::HEAD {
        file.seek(std::io::SeekFrom::Start(start)).await.ok()?;
        file.take(end - start + 1)
            .read_to_end(&mut data)
            .await
            .ok()?;
        if data.len() as u64 != end - start + 1 {
            return Some(error(
                StatusCode::BAD_GATEWAY,
                "Файл сохранённой серии повреждён.",
            ));
        }
    }
    Some(local_response(
        name,
        size,
        range.is_some() || end < wanted,
        start,
        end,
        data,
    ))
}

fn bounds(raw: Option<&str>, size: u64) -> Option<(u64, u64)> {
    if size == 0 {
        return None;
    }
    let Some(raw) = raw else {
        return Some((0, size - 1));
    };
    let (start, end) = raw.strip_prefix("bytes=")?.split_once('-')?;
    let (start, end) = if start.is_empty() {
        let length = end.parse().ok()?;
        (size.saturating_sub(length), size - 1)
    } else {
        let start: u64 = start.parse().ok()?;
        let end = if end.is_empty() {
            size - 1
        } else {
            end.parse::<u64>().ok()?.min(size - 1)
        };
        (start, end)
    };
    (start <= end && start < size).then_some((start, end))
}

fn local_response(
    name: &str,
    size: u64,
    partial: bool,
    start: u64,
    end: u64,
    data: Vec<u8>,
) -> Response<Vec<u8>> {
    let content = match name.rsplit_once('.').map(|(_, ext)| ext) {
        Some("m3u8") => "application/vnd.apple.mpegurl",
        Some("mpd") => "application/dash+xml",
        Some("ts") => "video/mp2t",
        Some("mp4" | "m4s") => "video/mp4",
        Some("vtt") => "text/vtt",
        _ => "application/octet-stream",
    };
    let mut response = Response::builder()
        .header(header::CONTENT_TYPE, content)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_LENGTH, end - start + 1);
    if partial {
        response = response
            .status(StatusCode::PARTIAL_CONTENT)
            .header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{size}"));
    }
    response.body(data).unwrap()
}

fn unsatisfiable(size: u64) -> Response<Vec<u8>> {
    Response::builder()
        .status(StatusCode::RANGE_NOT_SATISFIABLE)
        .header(header::CONTENT_RANGE, format!("bytes */{size}"))
        .body(Vec::new())
        .unwrap()
}

fn guard(window: &tauri::WebviewWindow) -> Result<()> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("Неизвестное окно.".into())
    }
}

#[tauri::command]
pub async fn list_downloads(
    window: tauri::WebviewWindow,
    store: tauri::State<'_, Store>,
) -> Result<Vec<Entry>> {
    guard(&window)?;
    let jobs = store.0.jobs.lock().await.clone();
    Ok(jobs)
}

#[tauri::command]
pub async fn enqueue_downloads(
    window: tauri::WebviewWindow,
    store: tauri::State<'_, Store>,
    requests: Vec<Request>,
) -> Result<Vec<Entry>> {
    guard(&window)?;
    store.enqueue(requests).await
}

#[tauri::command]
pub async fn change_download(
    window: tauri::WebviewWindow,
    store: tauri::State<'_, Store>,
    id: String,
    action: String,
) -> Result<Vec<Entry>> {
    guard(&window)?;
    store.change(&id, &action).await
}

#[tauri::command]
pub async fn remove_downloads(
    window: tauri::WebviewWindow,
    store: tauri::State<'_, Store>,
    ids: Vec<String>,
) -> Result<Vec<Entry>> {
    guard(&window)?;
    if ids.len() > LIMIT || ids.iter().any(|id| !hex(id)) {
        return Err("Не удалось выбрать загрузки для удаления.".into());
    }
    let mut jobs = store.0.jobs.lock().await;
    store
        .remove_entries(&mut jobs, ids.iter().map(String::as_str).collect())
        .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrefetchRequest {
    ticket: String,
    anime_id: u64,
    episode: String,
    quality: u32,
    candidates: Vec<Candidate>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageUsage {
    free: Option<u64>,
    ready: u64,
    partial: u64,
    video_cache: u64,
}

#[cfg(unix)]
type FileId = (u64, u64);
#[cfg(windows)]
type FileId = same_file::Handle;

fn unique_file(path: &Path, metadata: &std::fs::Metadata, seen: &mut HashSet<FileId>) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let _ = path;
        metadata.nlink() == 1 || seen.insert((metadata.dev(), metadata.ino()))
    }
    #[cfg(windows)]
    {
        let _ = metadata;
        match same_file::Handle::from_path(path) {
            Ok(id) => seen.insert(id),
            Err(_) => true,
        }
    }
}

fn directory_bytes(path: &Path, seen: &mut HashSet<FileId>) -> u64 {
    let Ok(entries) = std::fs::read_dir(path) else {
        return 0;
    };
    entries
        .flatten()
        .map(|entry| {
            let Ok(kind) = entry.file_type() else {
                return 0;
            };
            if kind.is_dir() {
                directory_bytes(&entry.path(), seen)
            } else if kind.is_file() {
                entry.metadata().map_or(0, |metadata| {
                    if unique_file(&entry.path(), &metadata, seen) {
                        metadata.len()
                    } else {
                        0
                    }
                })
            } else {
                0
            }
        })
        .fold(0, u64::saturating_add)
}

fn free_disk(path: &Path) -> Option<u64> {
    let path = path.ancestors().find(|path| path.is_dir())?;
    #[cfg(unix)]
    {
        use std::{ffi::CString, os::unix::ffi::OsStrExt};
        let path = CString::new(path.as_os_str().as_bytes()).ok()?;
        let mut info = std::mem::MaybeUninit::<libc::statvfs>::uninit();
        if unsafe { libc::statvfs(path.as_ptr(), info.as_mut_ptr()) } == 0 {
            let info = unsafe { info.assume_init() };
            return Some(
                u64::try_from(info.f_bavail)
                    .ok()?
                    .saturating_mul(info.f_frsize as u64),
            );
        }
        None
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
        let wide: Vec<_> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let mut available = 0;
        let success = unsafe {
            GetDiskFreeSpaceExW(
                wide.as_ptr(),
                &mut available,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };
        (success != 0).then_some(available)
    }
}

#[tauri::command]
pub async fn download_settings(
    window: tauri::WebviewWindow,
    store: tauri::State<'_, Store>,
    settings: Option<DownloadSettings>,
) -> Result<DownloadSettings> {
    guard(&window)?;
    let mut current = store.0.settings.lock().await;
    if let Some(settings) = settings {
        if !(1..=5).contains(&settings.concurrent) || settings.cached_episodes > 3 {
            return Err("Недопустимые настройки загрузок.".into());
        }
        let bytes = serde_json::to_vec(&settings).map_err(|_| "Не удалось сохранить настройки.")?;
        write(&store.0.root.join("settings.json"), &bytes).await?;
        let changed = current.cached_episodes != settings.cached_episodes;
        *current = settings;
        drop(current);
        store.0.changed.notify_one();
        if changed {
            if let Some((_, cancel)) = store.0.prefetch.lock().await.take() {
                cancel.notify_one();
            }
            store.prune_cache(false).await;
        }
        return Ok(settings);
    }
    Ok(*current)
}

#[tauri::command]
pub async fn download_storage(
    window: tauri::WebviewWindow,
    store: tauri::State<'_, Store>,
) -> Result<StorageUsage> {
    guard(&window)?;
    let root = store.0.root.clone();
    let jobs = store.0.jobs.lock().await.clone();
    tokio::task::spawn_blocking(move || {
        let mut seen = HashSet::new();
        let ready = jobs
            .iter()
            .filter(|job| job.status == State::Ready)
            .map(|job| directory_bytes(&root.join(&job.id), &mut seen))
            .fold(0, u64::saturating_add);
        let partial = directory_bytes(&root.join("partial"), &mut seen);
        let video_cache = directory_bytes(&root.join("cache"), &mut seen)
            .saturating_add(directory_bytes(&root.join("work"), &mut seen));
        StorageUsage {
            free: free_disk(&root),
            ready,
            partial,
            video_cache,
        }
    })
    .await
    .map_err(|_| "Не удалось прочитать использование диска.".into())
}

#[tauri::command]
pub async fn clear_download_storage(
    window: tauri::WebviewWindow,
    store: tauri::State<'_, Store>,
    category: String,
) -> Result<()> {
    guard(&window)?;
    if category == "video" {
        if let Some((_, cancel)) = store.0.prefetch.lock().await.take() {
            cancel.notify_one();
        }
        store.prune_cache(true).await;
        store.prune_work(RETAIN).await;
        let root = store.0.root.clone();
        let work = store.0.work.clone();
        let _ =
            tokio::task::spawn_blocking(move || prune_previous_work(&root, &work, Duration::ZERO))
                .await;
    } else if category == "ready" || category == "partial" {
        let mut jobs = store.0.jobs.lock().await;
        let ids: Vec<_> = jobs
            .iter()
            .filter(|job| (job.status == State::Ready) == (category == "ready"))
            .map(|job| job.id.clone())
            .collect();
        store
            .remove_entries(&mut jobs, ids.iter().map(String::as_str).collect())
            .await?;
    } else {
        return Err("Неизвестная категория данных.".into());
    }
    {
        let mut jobs = store.0.jobs.lock().await;
        for job in jobs
            .iter_mut()
            .filter(|job| job.waiting_for.as_deref() == Some("storage"))
        {
            job.retry_at = Some(Instant::now());
        }
    }
    store.0.changed.notify_one();
    Ok(())
}

#[tauri::command]
pub async fn prefetch_download_episode(
    window: tauri::WebviewWindow,
    store: tauri::State<'_, Store>,
    backend: tauri::State<'_, Backend>,
    request: PrefetchRequest,
) -> Result<()> {
    guard(&window)?;
    store.prefetch_episode(&backend, request).await
}

#[tauri::command]
pub async fn cancel_download_prefetch(
    window: tauri::WebviewWindow,
    store: tauri::State<'_, Store>,
    ticket: String,
) -> Result<()> {
    guard(&window)?;
    let mut active = store.0.prefetch.lock().await;
    if active.as_ref().is_some_and(|(id, _)| id == &ticket) {
        if let Some((_, cancel)) = active.take() {
            cancel.notify_one();
        }
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use tauri::http::Request as HttpRequest;

    const SESSION: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    #[derive(Clone, Default)]
    pub struct Fixture {
        responses: Arc<HashMap<String, Vec<u8>>>,
        counts: Arc<StdMutex<HashMap<String, usize>>>,
        failures: Arc<StdMutex<HashMap<String, usize>>>,
    }

    impl Fixture {
        fn new(items: &[(char, &str)]) -> Self {
            let responses = items
                .iter()
                .map(|&(key, value)| (part(key), value.as_bytes().to_vec()))
                .collect();
            Self {
                responses: Arc::new(responses),
                counts: Arc::default(),
                failures: Arc::default(),
            }
        }

        fn fail(&self, key: char, times: usize) {
            self.failures.lock().unwrap().insert(part(key), times);
        }

        fn count(&self, key: char) -> usize {
            self.counts
                .lock()
                .unwrap()
                .get(&part(key))
                .copied()
                .unwrap_or(0)
        }

        pub async fn fetch(&self, path: &str, headers: HeaderMap) -> Result<Response<Vec<u8>>> {
            *self
                .counts
                .lock()
                .unwrap()
                .entry(path.to_owned())
                .or_default() += 1;
            tokio::time::sleep(Duration::from_millis(15)).await;
            if let Some(left) = self.failures.lock().unwrap().get_mut(path) {
                if *left > 0 {
                    *left -= 1;
                    return Err("Источник прервал ответ.".into());
                }
            }
            let bytes = self.responses.get(path).ok_or("Неизвестная фикстура.")?;
            if let Some(range) = headers
                .get(header::RANGE)
                .and_then(|value| value.to_str().ok())
            {
                let size = bytes.len() as u64;
                let (start, end) =
                    bounds(Some(range), size).ok_or("Некорректный диапазон теста.")?;
                Ok(Response::builder()
                    .status(206)
                    .header(header::ETAG, "\"test\"")
                    .header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{size}"))
                    .body(bytes[start as usize..=end as usize].to_vec())
                    .unwrap())
            } else {
                Ok(Response::new(bytes.clone()))
            }
        }
    }

    fn resource(key: char) -> String {
        key.to_string().repeat(32)
    }

    fn part(key: char) -> String {
        format!("/media/{SESSION}/{}", resource(key))
    }

    struct Folder(PathBuf);

    impl Folder {
        fn new() -> Self {
            Self(std::env::temp_dir().join(format!("yumiwatch-download-{}", token())))
        }
    }

    impl Drop for Folder {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn request(asset: &Asset) -> Request {
        Request {
            active: Some(format!("/downloads/{}/{}", asset.id, asset.entry)),
            anime_id: 1,
            title: "Тест".into(),
            anime: None,
            episode: "1".into(),
            preview: None,
            voice: "Выбранная озвучка".into(),
            quality: 720,
            markers: HashMap::new(),
            candidates: vec![Candidate {
                url: "https://ru.yummyani.me/iframeCVH.html?anime_id=1&episode=1".into(),
                video_id: asset.video_id,
                dubbing: "Выбранная озвучка".into(),
                episode: "1".into(),
            }],
        }
    }

    async fn get(backend: &Backend, path: &str, range: Option<&str>) -> Response<Vec<u8>> {
        let mut request = HttpRequest::get(path);
        if let Some(range) = range {
            request = request.header(header::RANGE, range);
        }
        backend.media(request.body(Vec::new()).unwrap()).await
    }

    #[tokio::test]
    async fn reopens_a_broken_transfer_and_recovers_the_saved_segment_after_restart() {
        let root = Folder::new();
        let store = Store::new(root.0.clone());
        let playlist = format!(
            "#EXTM3U\n#EXTINF:3,\n{}\n#EXTINF:3,\n{}\n#EXT-X-ENDLIST\n",
            resource('1'),
            resource('2')
        );
        let fixture = Fixture::new(&[('0', &playlist), ('1', "first"), ('2', "second")]);
        fixture.fail('2', 2);
        let mut backend = Backend::new().unwrap().with_downloads(store.clone());
        backend.fixture = Some(fixture.clone());
        let asset = store
            .asset("CVH", 123, 720, &part('0'), Kind::Playlist, None, None)
            .await
            .unwrap();
        let mut job = store
            .enqueue(vec![request(&asset)])
            .await
            .unwrap()
            .remove(0);
        job.status = State::Downloading;
        store.0.jobs.lock().await[0].status = State::Downloading;

        store.run_attempt(&backend, &job).await;
        {
            let jobs = store.0.jobs.lock().await;
            assert!(matches!(jobs[0].status, State::Waiting));
            assert!(jobs[0].error.is_none());
            assert_eq!((jobs[0].done, jobs[0].saved_bytes), (1, 5));
        }
        assert_eq!(fixture.count('1'), 1);
        assert_eq!(fixture.count('2'), 2);
        drop(backend);
        drop(store);

        let store = Store::new(root.0.clone());
        let mut backend = Backend::new().unwrap().with_downloads(store.clone());
        backend.fixture = Some(fixture.clone());
        let asset = store
            .asset("CVH", 123, 720, &part('0'), Kind::Playlist, None, None)
            .await
            .unwrap();
        let job = {
            let mut jobs = store.0.jobs.lock().await;
            assert!(matches!(jobs[0].status, State::Queued));
            assert!(jobs[0].started);
            jobs[0].status = State::Downloading;
            jobs[0].clone()
        };
        store.0.live.lock().await.insert(job.id.clone(), asset);
        store.run_attempt(&backend, &job).await;
        assert_eq!(fixture.count('1'), 1);
        assert_eq!(fixture.count('2'), 3);
        assert!(matches!(store.0.jobs.lock().await[0].status, State::Ready));
    }

    #[tokio::test]
    async fn storage_counts_hard_linked_data_once() {
        let root = Folder::new();
        let ready = root.0.join("ready");
        let cache = root.0.join("cache");
        fs::create_dir_all(&ready).await.unwrap();
        fs::create_dir_all(&cache).await.unwrap();
        let source = ready.join("segment.ts");
        fs::write(&source, b"shared").await.unwrap();
        fs::hard_link(&source, cache.join("segment.ts"))
            .await
            .unwrap();
        fs::write(cache.join("other.ts"), b"abc").await.unwrap();
        let mut seen = HashSet::new();
        assert_eq!(directory_bytes(&ready, &mut seen), 6);
        assert_eq!(directory_bytes(&cache, &mut seen), 3);
    }

    #[tokio::test]
    async fn playback_and_downloader_share_hls_and_keep_only_the_selected_variant() {
        let root = Folder::new();
        let store = Store::new(root.0.clone());
        let master = format!("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100000,RESOLUTION=640x360\n{}\n#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=1280x720\n{}\n", resource('1'), resource('2'));
        let media = format!(
            "#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-DATERANGE:ID=\"opening\",X-START-TIME=1,DURATION=2\n#EXTINF:4,\n{}\n#EXTINF:4,\n{}\n#EXT-X-ENDLIST\n",
            resource('3'),
            resource('4')
        );
        let fixture = Fixture::new(&[
            ('0', &master),
            ('2', &media),
            ('3', "first segment"),
            ('4', "second segment"),
        ]);
        let mut backend = Backend::new().unwrap().with_downloads(store.clone());
        backend.fixture = Some(fixture.clone());
        let asset = store
            .asset("CVH", 123, 720, &part('0'), Kind::Playlist, None, None)
            .await
            .unwrap();
        let mut input = request(&asset);
        input
            .markers
            .insert(123, serde_json::json!({"ending":{"time":5,"length":2}}));
        let mut job = store.enqueue(vec![input]).await.unwrap().remove(0);
        job.status = State::Downloading;
        store.0.jobs.lock().await[0] = job.clone();

        let root_uri = format!("/downloads/{}/index.m3u8", asset.id);
        let root_response = get(&backend, &root_uri, None).await;
        let root_text = String::from_utf8(root_response.into_body()).unwrap();
        assert!(!root_text.contains("640x360"));
        let variant = root_text.lines().last().unwrap();
        let variant_uri = format!("/downloads/{}/{variant}", asset.id);
        let playlist =
            String::from_utf8(get(&backend, &variant_uri, None).await.into_body()).unwrap();
        let segment = playlist
            .lines()
            .find(|line| !line.starts_with('#'))
            .unwrap();
        let segment_uri = format!("/downloads/{}/{segment}", asset.id);

        // Simulate a seek cancelling the first read after the CDN request starts.
        let seeking = {
            let backend = backend.clone();
            let path = segment_uri.clone();
            tokio::spawn(async move { get(&backend, &path, None).await })
        };
        tokio::time::timeout(Duration::from_secs(1), async {
            while fixture.count('3') == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        seeking.abort();
        let (playing, saving) = tokio::join!(
            get(&backend, &segment_uri, Some("bytes=0-4")),
            store.download(&backend, &job),
        );
        assert_eq!(playing.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(playing.body(), b"first");
        let saved = saving.unwrap();
        assert_eq!(saved.skips["opening"]["time"].as_f64(), Some(1.0));
        assert_eq!(saved.skips["ending"]["time"].as_f64(), Some(5.0));
        assert_eq!(fixture.count('0'), 1);
        assert_eq!(fixture.count('1'), 0);
        assert_eq!(fixture.count('2'), 1);
        assert_eq!(fixture.count('3'), 1);
        assert_eq!(fixture.count('4'), 1);
        assert!(root.0.join(&job.id).join(segment).is_file());

        // Neither the old player address nor a new process needs the CDN after publication.
        let response = get(&backend, &segment_uri, None).await;
        assert_eq!(response.body(), b"first segment");
        let offline = Backend::new()
            .unwrap()
            .with_downloads(Store::new(root.0.clone()));
        let response = get(
            &offline,
            &format!("/{}/{}", saved.entry.rsplit_once('/').unwrap().0, segment),
            None,
        )
        .await;
        assert_eq!(response.body(), b"first segment");
        assert_eq!(fixture.count('3'), 1);
    }

    #[tokio::test]
    async fn incomplete_hls_uses_the_mp4_reserve_and_shares_byte_ranges() {
        let root = Folder::new();
        let store = Store::new(root.0.clone());
        let media = format!(
            "#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\n{}\n",
            resource('1')
        );
        let fixture = Fixture::new(&[('0', &media), ('5', "mp4 fixture")]);
        let mut backend = Backend::new().unwrap().with_downloads(store.clone());
        backend.fixture = Some(fixture.clone());
        let reserve = store
            .asset("CVH", 123, 720, &part('5'), Kind::Mp4, None, None)
            .await
            .unwrap();
        let asset = store
            .asset(
                "CVH",
                123,
                720,
                &part('0'),
                Kind::Playlist,
                None,
                Some(reserve.clone()),
            )
            .await
            .unwrap();
        let mut job = store
            .enqueue(vec![request(&asset)])
            .await
            .unwrap()
            .remove(0);
        job.status = State::Downloading;
        store.0.jobs.lock().await[0] = job.clone();
        let mp4_url = format!("/downloads/{}/video.mp4", reserve.id);
        let (playing, saving) = tokio::join!(
            get(&backend, &mp4_url, Some("bytes=4-10")),
            store.download(&backend, &job)
        );
        assert_eq!(playing.body(), b"fixture");
        let saved = saving.unwrap();
        assert!(saved.entry.ends_with("/video.mp4"));
        assert_eq!(fixture.count('1'), 0);
        assert_eq!(fixture.count('5'), 1);
        assert_eq!(
            fs::read(root.0.join(job.id).join(VIDEO)).await.unwrap(),
            b"mp4 fixture"
        );
    }

    #[tokio::test]
    async fn restores_a_completed_download_with_skip_markers_after_restart() {
        let root = Folder::new();
        let store = Store::new(root.0.clone());
        let asset = store
            .asset("CVH", 123, 720, &part('0'), Kind::Playlist, None, None)
            .await
            .unwrap();
        let mut input = request(&asset);
        let markers = serde_json::json!({"opening": {"time": 10.0, "length": 70.0}});
        input.markers.insert(asset.video_id, markers.clone());
        let mut entries = store.enqueue(vec![input]).await.unwrap();
        let entry = &mut entries[0];
        let folder = root.0.join(&entry.id);
        fs::create_dir_all(&folder).await.unwrap();
        fs::write(folder.join(INDEX), b"#EXTM3U").await.unwrap();
        entry.status = State::Ready;
        entry.stream = Some(Ready {
            provider: "CVH".into(),
            video_id: asset.video_id,
            quality: asset.quality,
            entry: format!("downloads/{}/{INDEX}", entry.id),
            caption: None,
            skips: markers.clone(),
        });
        store.persist(&entries).await.unwrap();
        drop(store);

        let restored = Store::new(root.0.clone());
        let read = restored.0.jobs.lock().await;
        assert_eq!(read.len(), 1);
        assert!(read[0].status == State::Ready);
        assert_eq!(read[0].request.markers[&asset.video_id], markers);
        assert_eq!(read[0].stream.as_ref().unwrap().skips, markers);
        drop(read);
        assert!(restored
            .playable(&entries[0].request.candidates, 480)
            .await
            .is_some());

        let index = root.0.join("jobs.json");
        let mut rows: Vec<Value> =
            serde_json::from_slice(&fs::read(&index).await.unwrap()).unwrap();
        rows.insert(0, serde_json::json!({"id": SESSION, "status": "invalid"}));
        write(&index, &serde_json::to_vec(&rows).unwrap())
            .await
            .unwrap();
        assert_eq!(
            Store::new(root.0.clone()).0.jobs.lock().await[0].id,
            entries[0].id
        );
    }

    #[tokio::test]
    async fn a_season_over_fifty_episodes_can_be_added_in_one_batch() {
        let root = Folder::new();
        let store = Store::new(root.0.clone());
        let asset = store
            .asset("CVH", 123, 720, &part('0'), Kind::Playlist, None, None)
            .await
            .unwrap();
        let requests = (1..=64)
            .map(|number| {
                let mut input = request(&asset);
                input.episode = number.to_string();
                input.candidates[0].episode = input.episode.clone();
                input.candidates[0].video_id += number;
                input
            })
            .collect();
        let queued = store.enqueue(requests).await.unwrap();
        assert_eq!(queued.len(), 64);
        assert!(queued.iter().all(|entry| entry.status == State::Queued));
        assert_eq!(Store::new(root.0.clone()).0.jobs.lock().await.len(), 64);
    }

    #[tokio::test]
    async fn local_playback_prefers_a_ready_copy_even_at_a_different_quality() {
        let root = Folder::new();
        let store = Store::new(root.0.clone());
        let asset = store
            .asset("CVH", 123, 720, &part('0'), Kind::Playlist, None, None)
            .await
            .unwrap();
        let original = request(&asset);
        let mut higher = original.clone();
        higher.quality = 1080;
        let jobs = store.enqueue(vec![original.clone(), higher]).await.unwrap();
        for job in jobs {
            let folder = root.0.join(&job.id);
            fs::create_dir_all(&folder).await.unwrap();
            fs::write(folder.join(INDEX), b"#EXTM3U").await.unwrap();
            let mut stored = store.0.jobs.lock().await;
            let entry = stored.iter_mut().find(|entry| entry.id == job.id).unwrap();
            entry.status = State::Ready;
            entry.stream = Some(Ready {
                provider: "CVH".into(),
                video_id: 123,
                quality: job.request.quality,
                entry: format!("downloads/{}/{INDEX}", job.id),
                caption: None,
                skips: serde_json::json!({"opening": {"time": 10, "length": 70}}),
            });
        }
        let mut candidates = original.candidates;
        candidates[0].url.push_str("&dubbing_code=refreshed");
        let local = store.playable(&candidates, 480).await.unwrap();
        assert_eq!(local["streams"][0]["quality"], 720);
        assert_eq!(local["streams"][0]["offline"], true);
        assert_eq!(local["skips"]["opening"]["time"], 10);
        assert_eq!(
            store.ready_copy(&candidates, 1440).await.unwrap().quality,
            1080
        );
        candidates[0].video_id = 124;
        assert!(store.playable(&candidates, 480).await.is_none());
    }

    #[tokio::test]
    async fn cancel_removes_unfinished_jobs_and_preserves_ready_downloads() {
        let root = Folder::new();
        let store = Store::new(root.0.clone());
        let asset = store
            .asset("CVH", 123, 720, &part('0'), Kind::Playlist, None, None)
            .await
            .unwrap();
        let first = request(&asset);
        let mut second = first.clone();
        second.episode = "2".into();
        second.candidates[0].episode = "2".into();
        let jobs = store.enqueue(vec![first, second]).await.unwrap();
        let active = &jobs[0].id;
        let ready = &jobs[1].id;
        {
            let mut stored = store.0.jobs.lock().await;
            stored[0].status = State::Downloading;
            stored[1].status = State::Ready;
        }
        assert!(store.change(ready, "cancel").await.is_err());
        let after = store.change(active, "cancel").await.unwrap();
        assert_eq!(after.len(), 1);
        assert_eq!(&after[0].id, ready);
        assert!(store.ensure_running(active).await.is_err());
        let restored = Store::new(root.0.clone());
        assert_eq!(restored.0.jobs.lock().await[0].id, *ready);
    }

    #[tokio::test]
    async fn batch_removal_rolls_back_on_registry_failure_and_survives_restart() {
        let root = Folder::new();
        let store = Store::new(root.0.clone());
        let asset = store
            .asset("CVH", 123, 720, &part('0'), Kind::Playlist, None, None)
            .await
            .unwrap();
        let requests = (1..=3)
            .map(|episode| {
                let mut input = request(&asset);
                input.episode = episode.to_string();
                input.candidates[0].episode = input.episode.clone();
                input
            })
            .collect();
        let entries = store.enqueue(requests).await.unwrap();
        let saved_path = root.0.join(&entries[0].id);
        fs::create_dir(&saved_path).await.unwrap();
        let interrupted = root.0.join(format!("{}.removed", entries[0].id));
        fs::rename(&saved_path, &interrupted).await.unwrap();
        let store = Store::new(root.0.clone());
        assert!(saved_path.is_dir());

        let ids = || HashSet::from([entries[0].id.as_str(), entries[1].id.as_str()]);
        let mut jobs = store.0.jobs.lock().await;
        let registry = root.0.join("jobs.json");
        let original = std::fs::read(&registry).unwrap();
        fs::remove_file(&registry).await.unwrap();
        fs::create_dir(&registry).await.unwrap();
        assert!(store.remove_entries(&mut jobs, ids()).await.is_err());
        assert_eq!(jobs.len(), 3);
        assert!(saved_path.is_dir());
        assert!(!interrupted.exists());
        fs::remove_dir(&registry).await.unwrap();
        write(&registry, &original).await.unwrap();

        let removed = store.remove_entries(&mut jobs, ids()).await.unwrap();
        assert_eq!(removed.len(), 1);
        assert_eq!(removed[0].id, entries[2].id);
        assert!(!saved_path.exists());
        drop(jobs);
        let restored = Store::new(root.0.clone());
        assert_eq!(restored.0.jobs.lock().await[0].id, entries[2].id);
        assert!(!interrupted.exists());
    }

    #[test]
    fn rewrites_init_and_implicit_byte_ranges_and_preserves_timing_tags() {
        let source = "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:10\n#EXT-X-MAP:URI=\"video\",BYTERANGE=\"8@2\"\n#EXTINF:3,\n#EXT-X-BYTERANGE:20@10\nvideo\n#EXT-X-DISCONTINUITY\n#EXTINF:4,\n#EXT-X-BYTERANGE:30\nvideo\n#EXT-X-ENDLIST\n";
        let mut ranges = Vec::new();
        let result = download_hls::localize(source, 720, Kind::Playlist, |_, kind, range| {
            ranges.push((kind, range));
            Ok(format!("{}.{}", ranges.len(), kind.extension()))
        })
        .unwrap();
        assert_eq!(
            ranges,
            [
                (Kind::Init, Some(ByteRange { start: 2, size: 8 })),
                (
                    Kind::Fragment,
                    Some(ByteRange {
                        start: 10,
                        size: 20
                    })
                ),
                (
                    Kind::Fragment,
                    Some(ByteRange {
                        start: 30,
                        size: 30
                    })
                ),
            ]
        );
        assert!(result.contains("#EXT-X-MAP:URI=\"1.mp4\""));
        assert!(result.contains("#EXT-X-DISCONTINUITY"));
        assert!(!result.contains("BYTERANGE"));
        assert!(route(&format!("/downloads/{SESSION}/2.m4s")).is_some());
        assert!(route(&format!("/downloads/{SESSION}/../video.mp4")).is_none());
    }
}

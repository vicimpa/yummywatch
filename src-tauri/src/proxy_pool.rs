use std::{
    collections::{HashMap, HashSet, VecDeque},
    fs,
    future::Future,
    io::{ErrorKind, Write},
    net::{IpAddr, SocketAddr},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use futures_util::{stream::FuturesUnordered, StreamExt};
use rand::seq::SliceRandom;
use reqwest::{Client, Proxy, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::{watch, Notify, Semaphore};
use tokio::task::JoinSet;
use url::{Position, Url};

use crate::providers;

const FEEDS: [(&str, &str); 3] = [
    (
        "ProxMint",
        "https://raw.githubusercontent.com/proxmint/free-proxy-list/main/proxies/all.txt",
    ),
    (
        "ProxyFly",
        "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/all/data.txt",
    ),
    (
        "Monosans",
        "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/all.txt",
    ),
];
const PLAYERS: [(&str, &str); 4] = [
    ("kodik", "Kodik"),
    ("aksor", "Aksor"),
    ("alloha", "Alloha"),
    ("cvh", "CVH"),
];
// Use an existing, immutable copy of the public 871-byte app manifest.
const PROBE: &str = "https://raw.githubusercontent.com/vicimpa/yummywatch/4108380af1b25c173b2b3331fb00f7999d0f8e48/public/manifest.webmanifest";
const PROBE_TIMEOUT: Duration = Duration::from_millis(2500);
const FEED_REFRESH: Duration = Duration::from_secs(10 * 60);
const VERIFIED_TTL: Duration = Duration::from_secs(15 * 60);
const PROVIDER_COOLDOWN: Duration = Duration::from_secs(5 * 60);
const ATTEMPT_TIMEOUT: Duration = Duration::from_secs(5);
const FALLBACK_TIMEOUT: Duration = Duration::from_secs(12);
const PARALLEL_ROUTES: usize = 3;
const MAX_CUSTOM: usize = 32;
const CUSTOM_RECHECK: Duration = Duration::from_secs(60);

#[derive(Clone)]
pub(super) struct Pool {
    state: Arc<Mutex<PoolState>>,
    config: watch::Sender<Configuration>,
    ready: Arc<Notify>,
    demand: Arc<Notify>,
    manual: Arc<Notify>,
    attempts: Arc<Semaphore>,
    disabled_file: Option<PathBuf>,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
struct Endpoint {
    scheme: &'static str,
    address: SocketAddr,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
enum Route {
    Public(Endpoint),
    Custom(u32),
}

#[derive(Clone, Deserialize, Serialize)]
struct CustomProxy {
    id: u32,
    url: Url,
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase")]
pub(crate) enum CustomProxyChange {
    Add { address: String },
    Remove { id: u32 },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CustomProxyStatus {
    id: u32,
    address: String,
    authenticated: bool,
    reachable: Option<bool>,
}

#[derive(Clone, Copy, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PoolPreferences {
    pub interval_seconds: u64,
    pub concurrent_checks: usize,
    pub feeds: [bool; FEEDS.len()],
}

impl Default for PoolPreferences {
    fn default() -> Self {
        Self {
            interval_seconds: 4,
            concurrent_checks: 4,
            feeds: [true; FEEDS.len()],
        }
    }
}

impl PoolPreferences {
    fn valid(self) -> bool {
        [2, 4, 10, 30].contains(&self.interval_seconds)
            && [1, 2, 4, 6].contains(&self.concurrent_checks)
    }
}

#[derive(Clone, Copy, Eq, PartialEq)]
struct Configuration {
    enabled: bool,
    preferences: PoolPreferences,
    custom_revision: u64,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct FeedStatus {
    addresses: usize,
    updated_at: Option<u64>,
    error: Option<String>,
}

#[derive(Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProbeResult {
    checked: u64,
    passed: u64,
    completed_at: Option<u64>,
}

impl ProbeResult {
    fn record(&mut self, passed: bool) {
        self.checked += 1;
        self.passed += u64::from(passed);
        self.completed_at = Some(timestamp());
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PoolReport {
    preferences: PoolPreferences,
    custom_proxies: Vec<CustomProxyStatus>,
    feeds: [(&'static str, FeedStatus); FEEDS.len()],
    working: usize,
    queued: usize,
    probes: ProbeResult,
    manual_pending: bool,
    last_manual: Option<ProbeResult>,
    players: Vec<(&'static str, u64, u64, Option<u64>)>,
}

#[derive(Default)]
struct PoolState {
    verified: HashMap<Route, Verified>,
    custom: Vec<CustomProxy>,
    custom_checked: HashMap<u32, Instant>,
    providers: HashMap<&'static str, ProviderRoutes>,
    feeds: [FeedStatus; FEEDS.len()],
    queued: usize,
    probes: ProbeResult,
    manual_requested: bool,
    manual_running: bool,
    last_manual: Option<ProbeResult>,
}

#[derive(Default)]
struct ProviderRoutes {
    failed: HashMap<Route, Instant>,
    last_success: Option<Route>,
    attempts: u64,
    successes: u64,
    last_success_at: Option<u64>,
}

struct Verified {
    client: Client,
    checked: Instant,
    latency: Duration,
}

impl Pool {
    pub(super) fn new(disabled_file: Option<PathBuf>) -> Self {
        let enabled = disabled_file
            .as_ref()
            .is_none_or(|path| matches!(path.try_exists(), Ok(false)));
        let preferences = disabled_file
            .as_deref()
            .and_then(|path| fs::read(path.with_file_name("proxy-pool.json")).ok())
            .and_then(|bytes| serde_json::from_slice::<PoolPreferences>(&bytes).ok())
            .filter(|preferences| preferences.valid())
            .unwrap_or_default();
        let custom = disabled_file
            .as_deref()
            .and_then(|path| fs::read(path.with_file_name("custom-proxies.json")).ok())
            .and_then(|bytes| serde_json::from_slice::<Vec<CustomProxy>>(&bytes).ok())
            .filter(|proxies| {
                proxies.len() <= MAX_CUSTOM
                    && proxies
                        .iter()
                        .all(|proxy| custom_proxy_url(proxy.url.as_str()).is_ok())
            })
            .unwrap_or_default();
        Self {
            state: Arc::new(Mutex::new(PoolState {
                custom,
                ..Default::default()
            })),
            config: watch::channel(Configuration {
                enabled,
                preferences,
                custom_revision: 0,
            })
            .0,
            ready: Arc::default(),
            demand: Arc::default(),
            manual: Arc::default(),
            attempts: Arc::new(Semaphore::new(8)),
            disabled_file,
        }
    }

    pub(super) fn settings(&self, enabled: Option<bool>) -> Result<bool, String> {
        let mut state = self.state.lock().unwrap();
        let current = *self.config.borrow();
        let Some(enabled) = enabled.filter(|enabled| *enabled != current.enabled) else {
            return Ok(current.enabled);
        };
        if let Some(path) = &self.disabled_file {
            let saved = if enabled {
                ignore_file_error(fs::remove_file(path), ErrorKind::NotFound)
            } else {
                path.parent()
                    .map_or(Ok(()), fs::create_dir_all)
                    .and_then(|()| {
                        ignore_file_error(
                            fs::OpenOptions::new()
                                .write(true)
                                .create_new(true)
                                .open(path),
                            ErrorKind::AlreadyExists,
                        )
                    })
            };
            saved.map_err(|_| "Не удалось сохранить настройки прокси.".to_string())?;
        }
        state.clear_routes();
        state.queued = 0;
        state.manual_requested = false;
        state.manual_running = false;
        self.config
            .send_replace(Configuration { enabled, ..current });
        Ok(enabled)
    }

    pub(super) fn enabled(&self) -> bool {
        self.config.borrow().enabled
    }

    pub(super) fn edit_custom(&self, change: CustomProxyChange) -> providers::Result<()> {
        let mut state = self.state.lock().unwrap();
        let mut custom = state.custom.clone();
        let removed = match change {
            CustomProxyChange::Add { address } => {
                let url = custom_proxy_url(&address)?;
                if custom.iter().any(|proxy| proxy.url == url) {
                    return Err("Этот прокси уже добавлен.".into());
                }
                if custom.len() >= MAX_CUSTOM {
                    return Err(format!("Можно добавить до {MAX_CUSTOM} своих прокси."));
                }
                let mut id = rand::random();
                while custom.iter().any(|proxy| proxy.id == id) {
                    id = rand::random();
                }
                custom.push(CustomProxy { id, url });
                None
            }
            CustomProxyChange::Remove { id } => {
                custom.retain(|proxy| proxy.id != id);
                if custom.len() == state.custom.len() {
                    return Ok(());
                }
                Some(id)
            }
        };
        if let Some(path) = &self.disabled_file {
            save_settings(&path.with_file_name("custom-proxies.json"), &custom)
                .map_err(|_| "Не удалось сохранить свои прокси.")?;
        }
        state.custom = custom;
        if let Some(id) = removed {
            let route = Route::Custom(id);
            state.verified.remove(&route);
            state.custom_checked.remove(&id);
            for player in state.providers.values_mut() {
                player.failed.remove(&route);
                if player.last_success == Some(route) {
                    player.last_success = None;
                }
            }
        }
        state.manual_requested |= state.manual_running;
        state.manual_running = false;
        self.config
            .send_modify(|config| config.custom_revision += 1);
        Ok(())
    }

    pub(super) fn report(
        &self,
        preferences: Option<PoolPreferences>,
        check_now: bool,
    ) -> providers::Result<PoolReport> {
        let mut state = self.state.lock().unwrap();
        let mut config = *self.config.borrow();
        if check_now && !config.enabled {
            return Err("Включи прокси, чтобы запустить проверку.".into());
        }
        if let Some(preferences) = preferences {
            if !preferences.valid() {
                return Err("Выбери допустимые параметры проверки.".into());
            }
            if preferences != config.preferences {
                if let Some(path) = &self.disabled_file {
                    save_settings(&path.with_file_name("proxy-pool.json"), &preferences)
                        .map_err(|_| "Не удалось сохранить настройки пула прокси.")?;
                }
                if preferences.feeds != config.preferences.feeds {
                    for (index, status) in state.feeds.iter_mut().enumerate() {
                        if preferences.feeds[index] != config.preferences.feeds[index] {
                            *status = FeedStatus::default();
                        }
                    }
                    state.clear_routes();
                }
                state.manual_requested |= state.manual_running;
                state.manual_running = false;
                state.queued = 0;
                config.preferences = preferences;
                self.config.send_replace(config);
            }
        }
        if check_now && !state.manual_running && !state.manual_requested {
            state.manual_requested = true;
            self.manual.notify_waiters();
        }
        state.prune();
        Ok(PoolReport {
            preferences: config.preferences,
            custom_proxies: state
                .custom
                .iter()
                .map(|proxy| CustomProxyStatus {
                    id: proxy.id,
                    address: format!(
                        "{}://{}",
                        proxy.url.scheme(),
                        &proxy.url[Position::BeforeHost..Position::AfterPort]
                    ),
                    authenticated: !proxy.url.username().is_empty(),
                    reachable: state
                        .custom_checked
                        .get(&proxy.id)
                        .map(|_| state.verified.contains_key(&Route::Custom(proxy.id))),
                })
                .collect(),
            feeds: std::array::from_fn(|index| (FEEDS[index].0, state.feeds[index].clone())),
            working: state.verified.len(),
            queued: state.queued,
            probes: state.probes,
            manual_pending: state.manual_requested || state.manual_running,
            last_manual: state.last_manual,
            players: PLAYERS
                .iter()
                .map(|&(family, name)| match state.providers.get(family) {
                    Some(routes) => (
                        name,
                        routes.attempts,
                        routes.successes,
                        routes.last_success_at,
                    ),
                    None => (name, 0, 0, None),
                })
                .collect(),
        })
    }

    pub(super) fn start(&self, client: Client) {
        let pool = self.clone();
        tauri::async_runtime::spawn(async move {
            let mut config = pool.config.subscribe();
            loop {
                let current = *config.borrow_and_update();
                if current.enabled {
                    tokio::select! {
                        biased;
                        _ = config.changed() => {}
                        _ = pool.check_proxies(&client, current) => {}
                    }
                } else {
                    let _ = config.changed().await;
                }
            }
        });
    }

    async fn check_proxies(&self, client: &Client, config: Configuration) {
        let mut feeds: [Vec<Endpoint>; FEEDS.len()] = Default::default();
        let mut queue = VecDeque::new();
        let mut next_refresh = Instant::now();
        let interval = Duration::from_secs(config.preferences.interval_seconds);
        loop {
            let (manual, custom) = {
                let mut state = self.state.lock().unwrap();
                if *self.config.borrow() != config {
                    return;
                }
                state.manual_running = std::mem::take(&mut state.manual_requested);
                let mut custom: Vec<_> = state
                    .custom
                    .iter()
                    .filter(|proxy| {
                        state.manual_running
                            || state
                                .custom_checked
                                .get(&proxy.id)
                                .is_none_or(|checked| checked.elapsed() >= CUSTOM_RECHECK)
                    })
                    .collect();
                custom.sort_by_key(|proxy| state.custom_checked.get(&proxy.id).copied());
                let custom: Vec<_> = custom
                    .into_iter()
                    .take(config.preferences.concurrent_checks)
                    .map(|proxy| (Route::Custom(proxy.id), proxy.url.as_str().to_owned()))
                    .collect();
                (state.manual_running, custom)
            };
            if manual || Instant::now() >= next_refresh {
                let results = refresh_feeds(client, config.preferences.feeds).await;
                let mut state = self.state.lock().unwrap();
                if *self.config.borrow() != config {
                    return;
                }
                let mut refreshed = false;
                for (index, result) in results.into_iter().enumerate() {
                    let Some(result) = result else {
                        continue;
                    };
                    let status = &mut state.feeds[index];
                    match result {
                        Ok(list) => {
                            status.addresses = list.len();
                            status.updated_at = Some(timestamp());
                            status.error = None;
                            feeds[index] = list;
                            refreshed = true;
                        }
                        Err(error) => status.error = Some(error),
                    }
                }
                if refreshed {
                    update_queue(&mut queue, &feeds);
                }
                next_refresh = Instant::now()
                    + if refreshed {
                        FEED_REFRESH
                    } else {
                        Duration::from_secs(60)
                    };
            }
            let mut result = ProbeResult::default();
            let mut checks = FuturesUnordered::new();
            let public_count =
                (config.preferences.concurrent_checks - custom.len()).min(queue.len());
            let public = queue.drain(..public_count).map(|address| {
                (
                    Route::Public(address),
                    format!("{}://{}", address.scheme, address.address),
                )
            });
            for (route, url) in custom.into_iter().chain(public) {
                checks.push(async move {
                    let checked = Instant::now();
                    (route, checked, probe(&url).await)
                });
            }
            while let Some((route, checked, client)) = checks.next().await {
                let mut state = self.state.lock().unwrap();
                if *self.config.borrow() != config {
                    return;
                }
                state.queued = queue.len();
                state.prune();
                state.probes.record(client.is_some());
                result.record(client.is_some());
                if let Route::Custom(id) = route {
                    state.custom_checked.insert(id, checked);
                }
                if let Some(client) = client {
                    state.verified.insert(
                        route,
                        Verified {
                            client,
                            checked,
                            latency: checked.elapsed(),
                        },
                    );
                    self.ready.notify_waiters();
                } else {
                    state.verified.remove(&route);
                }
            }
            let wake = self.manual.notified();
            tokio::pin!(wake);
            wake.as_mut().enable();
            {
                let mut state = self.state.lock().unwrap();
                if *self.config.borrow() != config {
                    return;
                }
                state.queued = queue.len();
                if manual {
                    result.completed_at = Some(timestamp());
                    state.last_manual = Some(result);
                    state.manual_running = false;
                }
                if state.manual_requested {
                    continue;
                }
            }
            self.ready.notify_waiters();
            tokio::select! {
                _ = tokio::time::sleep(interval) => {}
                _ = &mut wake => {}
                _ = self.demand.notified(), if !queue.is_empty() => {
                    tokio::time::sleep(Duration::from_millis(250)).await;
                }
            }
        }
    }

    pub(super) async fn retry<T, F, Fut>(
        &self,
        family: &'static str,
        direct_error: String,
        resolve: F,
    ) -> providers::Result<T>
    where
        F: Fn(Client) -> Fut,
        Fut: Future<Output = providers::Result<T>>,
    {
        let mut config = self.config.subscribe();
        let current = *config.borrow_and_update();
        if !current.enabled
            || !current.preferences.feeds.contains(&true)
                && self.state.lock().unwrap().custom.is_empty()
        {
            return Err(direct_error);
        }
        let deadline = tokio::time::sleep(FALLBACK_TIMEOUT);
        tokio::pin!(deadline);
        let mut attempted = HashSet::new();
        let mut completed = 0;
        let mut attempts = FuturesUnordered::new();
        loop {
            let ready = self.ready.notified();
            tokio::pin!(ready);
            ready.as_mut().enable();
            let routes = self.state.lock().unwrap().routes(
                family,
                &attempted,
                PARALLEL_ROUTES - attempts.len(),
            );
            for (address, client) in routes {
                attempted.insert(address);
                let resolve = &resolve;
                attempts.push(async move {
                    let _permit = self
                        .attempts
                        .acquire()
                        .await
                        .expect("proxy semaphore closed");
                    let result = tokio::time::timeout(ATTEMPT_TIMEOUT, resolve(client)).await;
                    (address, result)
                });
            }
            if attempts.is_empty() {
                self.demand.notify_one();
            }
            tokio::select! {
                biased;
                _ = config.changed() => return Err(direct_error),
                _ = &mut deadline => break,
                Some((address, result)) = attempts.next(), if !attempts.is_empty() => {
                    completed += 1;
                    let mut state = self.state.lock().unwrap();
                    if config.has_changed().unwrap_or(true) {
                        return Err(direct_error);
                    }
                    let routes = state.providers.entry(family).or_default();
                    routes.attempts += 1;
                    match result {
                        Ok(Ok(result)) => {
                            routes.failed.remove(&address);
                            routes.last_success = Some(address);
                            routes.successes += 1;
                            routes.last_success_at = Some(timestamp());
                            return Ok(result);
                        }
                        Ok(Err(error)) if !providers::should_retry_with_proxy(&error) => {}
                        _ => {
                            routes.failed.insert(address, Instant::now());
                            if routes.last_success == Some(address) {
                                routes.last_success = None;
                            }
                        }
                    }
                }
                _ = &mut ready => {}
            }
        }
        let status = if completed == 0 {
            "Нет доступного проверенного прокси для источника.".to_owned()
        } else {
            format!("Прокси не открыли источник (попыток: {completed}).")
        };
        Err(format!("{direct_error} {status}"))
    }
}

fn ignore_file_error<T>(result: std::io::Result<T>, ignored: ErrorKind) -> std::io::Result<()> {
    match result {
        Ok(_) => Ok(()),
        Err(error) if error.kind() == ignored => Ok(()),
        Err(error) => Err(error),
    }
}

fn timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn save_settings(path: &std::path::Path, value: &impl Serialize) -> std::io::Result<()> {
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(std::path::Path::new("."));
    fs::create_dir_all(parent)?;
    let temporary = path.with_extension(format!("{:016x}.tmp", rand::random::<u64>()));
    let saved = (|| {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        file.write_all(&serde_json::to_vec(value)?)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, path)
    })();
    if saved.is_err() {
        let _ = fs::remove_file(temporary);
    }
    saved
}

impl PoolState {
    fn clear_routes(&mut self) {
        self.verified.clear();
        self.custom_checked.clear();
        for routes in self.providers.values_mut() {
            routes.failed.clear();
            routes.last_success = None;
        }
    }

    fn prune(&mut self) {
        self.verified
            .retain(|_, entry| entry.checked.elapsed() < VERIFIED_TTL);
        for routes in self.providers.values_mut() {
            routes
                .failed
                .retain(|_, time| time.elapsed() < PROVIDER_COOLDOWN);
        }
    }

    fn routes(
        &mut self,
        family: &'static str,
        attempted: &HashSet<Route>,
        limit: usize,
    ) -> Vec<(Route, Client)> {
        self.prune();
        let routes = self.providers.get(family);
        let mut entries: Vec<_> = self
            .verified
            .iter()
            .filter(|(address, _)| {
                !attempted.contains(address)
                    && !routes.is_some_and(|routes| routes.failed.contains_key(address))
            })
            .collect();
        entries.sort_unstable_by_key(|(&address, entry)| {
            (
                !matches!(address, Route::Custom(_)),
                routes.and_then(|routes| routes.last_success) != Some(address),
                entry.latency,
            )
        });
        entries
            .into_iter()
            .take(limit)
            .map(|(&address, entry)| (address, entry.client.clone()))
            .collect()
    }
}

async fn refresh_feeds(
    client: &Client,
    selected: [bool; FEEDS.len()],
) -> [Option<providers::Result<Vec<Endpoint>>>; FEEDS.len()] {
    let mut downloads = JoinSet::new();
    for (index, (_, url)) in FEEDS
        .into_iter()
        .enumerate()
        .filter(|(index, _)| selected[*index])
    {
        let client = client.clone();
        downloads.spawn(async move {
            let result = async {
                let response = client
                    .get(url)
                    .timeout(Duration::from_secs(6))
                    .send()
                    .await
                    .map_err(|_| "Список недоступен.")?;
                let bytes = providers::limited_body(response, 512 * 1024).await?;
                let text = std::str::from_utf8(&bytes).map_err(|_| "Некорректный список.")?;
                let mut unique = HashSet::new();
                Ok(text
                    .lines()
                    .filter_map(parse_endpoint)
                    .filter(|address| unique.insert(*address))
                    .collect())
            }
            .await;
            (index, result)
        });
    }
    let mut reports = [const { None }; FEEDS.len()];
    while let Some(result) = downloads.join_next().await {
        if let Ok((index, list)) = result {
            reports[index] = Some(list);
        }
    }
    reports
}

fn update_queue(queue: &mut VecDeque<Endpoint>, feeds: &[Vec<Endpoint>]) {
    let mut remaining = HashMap::<_, usize>::new();
    for feed in feeds {
        for address in feed.iter().copied().collect::<HashSet<_>>() {
            *remaining.entry(address).or_default() += 1;
        }
    }
    // Retain the order of candidates still waiting to be checked.
    queue.retain(|address| remaining.remove(address).is_some());
    let mut new: Vec<_> = remaining.into_iter().collect();
    new.shuffle(&mut rand::rng());
    new.sort_by_key(|&(_, feeds)| std::cmp::Reverse(feeds));
    queue.extend(new.into_iter().map(|(address, _)| address));
}

fn parse_endpoint(line: &str) -> Option<Endpoint> {
    let line = line.trim();
    let (scheme, address) = line.split_once("://").unwrap_or(("http", line));
    let scheme = match scheme {
        "http" => "http",
        "https" => "https",
        "socks4" | "socks4a" => "socks4a",
        "socks5" | "socks5h" => "socks5h",
        _ => return None,
    };
    let address: SocketAddr = address.parse().ok()?;
    if address.port() == 0 {
        return None;
    }
    let public = match address.ip() {
        IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            !(a == 0
                || a >= 224
                || ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_documentation()
                || (a == 100 && (64..=127).contains(&b))
                || (a == 192 && b == 0 && c == 0)
                || (a == 192 && b == 88 && c == 99)
                || (a == 198 && matches!(b, 18 | 19)))
        }
        IpAddr::V6(ip) => {
            let [a, b, ..] = ip.segments();
            (0x2000..0x4000).contains(&a)
                && !(a == 0x2001 && (b < 0x0200 || b == 0x0db8))
                && a != 0x2002
                && a != 0x3fff
        }
    };
    public.then_some(Endpoint { scheme, address })
}

fn custom_proxy_url(address: &str) -> providers::Result<Url> {
    const INVALID: &str = "Укажи адрес прокси в формате host:port или URL HTTP, HTTPS либо SOCKS.";
    let address = address.trim();
    if address.is_empty()
        || address.len() > 2048
        || address
            .chars()
            .any(|ch| ch.is_whitespace() || ch.is_control() || ch == '\\')
    {
        return Err(INVALID.into());
    }
    let raw = if address.contains("://") {
        address.to_owned()
    } else {
        format!("http://{address}")
    };
    let mut url = Url::parse(&raw).map_err(|_| INVALID)?;
    let default_port = match url.scheme() {
        "http" => 80,
        "https" => 443,
        "socks4" | "socks4a" | "socks5" | "socks5h" => 1080,
        _ => return Err(INVALID.into()),
    };
    if url.host_str().is_none()
        || url.port() == Some(0)
        || !matches!(url.path(), "" | "/")
        || url.query().is_some()
        || url.fragment().is_some()
        || url.password().is_some() && url.username().is_empty()
        || matches!(url.scheme(), "socks4" | "socks4a") && !url.username().is_empty()
    {
        return Err(INVALID.into());
    }
    if url.port().is_none() {
        url.set_port(Some(default_port)).map_err(|_| INVALID)?;
    }
    Ok(url)
}

async fn probe(proxy: &str) -> Option<Client> {
    let client = Client::builder()
        .user_agent("Mozilla/5.0")
        .proxy(Proxy::all(proxy).ok()?)
        .connect_timeout(PROBE_TIMEOUT)
        .pool_idle_timeout(Duration::from_secs(3))
        .pool_max_idle_per_host(1)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .ok()?;
    let response = client.get(PROBE).timeout(PROBE_TIMEOUT).send().await.ok()?;
    if response.status() != StatusCode::OK {
        return None;
    }
    let bytes = providers::limited_body(response, 2048).await.ok()?;
    valid_probe(&bytes).then_some(client)
}

fn valid_probe(bytes: &[u8]) -> bool {
    serde_json::from_slice::<Value>(bytes).is_ok_and(|manifest| {
        manifest["id"] == "./"
            && manifest["short_name"] == "YummyWatch"
            && manifest["start_url"] == "./"
            && manifest["display"] == "standalone"
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disabling_the_pool_survives_a_restart() {
        let directory =
            std::env::temp_dir().join(format!("yummywatch-proxy-test-{}", rand::random::<u64>()));
        let file = directory.join("proxy-disabled");
        let pool = Pool::new(Some(file.clone()));
        assert_eq!(pool.settings(None), Ok(true));
        assert_eq!(pool.settings(Some(false)), Ok(false));
        let restarted = Pool::new(Some(file.clone()));
        assert_eq!(restarted.settings(None), Ok(false));
        assert_eq!(restarted.settings(Some(true)), Ok(true));
        assert_eq!(Pool::new(Some(file)).settings(None), Ok(true));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn pool_preferences_survive_a_restart_and_validate_manual_requests() {
        let directory =
            std::env::temp_dir().join(format!("yummywatch-proxy-test-{}", rand::random::<u64>()));
        let file = directory.join("proxy-disabled");
        let pool = Pool::new(Some(file.clone()));
        let preferences = PoolPreferences {
            interval_seconds: 10,
            concurrent_checks: 2,
            feeds: [true, false, true],
        };
        assert!(pool.report(Some(preferences), true).unwrap().manual_pending);
        let invalid = PoolPreferences {
            interval_seconds: 0,
            ..preferences
        };
        assert!(pool.report(Some(invalid), false).is_err());
        pool.settings(Some(false)).unwrap();
        assert!(!pool.report(None, false).unwrap().manual_pending);
        assert!(pool.report(None, true).is_err());
        let restarted = Pool::new(Some(file));
        assert!(restarted.report(None, false).unwrap().preferences == preferences);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn private_and_authenticated_proxies_are_persisted_without_exposing_credentials() {
        let directory =
            std::env::temp_dir().join(format!("yummywatch-custom-proxy-{}", rand::random::<u64>()));
        let file = directory.join("proxy-disabled");
        let pool = Pool::new(Some(file.clone()));
        let address = "http://test-login:test-password@192.168.0.8:3128";
        let add = || CustomProxyChange::Add {
            address: address.into(),
        };
        pool.edit_custom(add()).unwrap();
        assert!(pool.edit_custom(add()).is_err());
        let preferences = PoolPreferences {
            feeds: [false; FEEDS.len()],
            ..Default::default()
        };
        pool.report(Some(preferences), false).unwrap();
        let restarted = Pool::new(Some(file));
        let report = restarted.report(None, false).unwrap();
        assert_eq!(report.preferences.feeds, [false; FEEDS.len()]);
        let proxy = &report.custom_proxies[0];
        assert_eq!(proxy.address, "http://192.168.0.8:3128");
        assert!(proxy.authenticated);
        assert_eq!(proxy.reachable, None);
        let encoded = serde_json::to_string(&report).unwrap();
        assert!(!encoded.contains("test-login") && !encoded.contains("test-password"));
        assert!(parse_endpoint("http://192.168.0.8:3128").is_none());
        restarted
            .edit_custom(CustomProxyChange::Remove { id: proxy.id })
            .unwrap();
        assert!(restarted
            .report(None, false)
            .unwrap()
            .custom_proxies
            .is_empty());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn custom_proxy_accepts_proxy_urls_without_target_paths() {
        for address in [
            "192.168.1.5:8080",
            "https://proxy.example:8443",
            "socks5://proxy.example:1080",
            "socks5h://[::1]:1080",
        ] {
            assert!(custom_proxy_url(address).is_ok(), "{address}");
        }
        for address in [
            "ftp://proxy.example:8080",
            "http://proxy.example:8080/archive",
            "http://proxy.example/?q=1",
            "http://proxy.example:0",
        ] {
            assert!(custom_proxy_url(address).is_err(), "{address}");
        }
    }

    #[tokio::test(start_paused = true)]
    async fn disabling_the_pool_cancels_a_pending_retry() {
        let pool = Pool::new(None);
        let attempt = pool.retry("alloha", "Alloha вернул 500".into(), |_| async {
            Ok(())
        });
        tokio::pin!(attempt);
        assert!(
            tokio::time::timeout(Duration::from_millis(10), &mut attempt)
                .await
                .is_err()
        );
        pool.settings(Some(false)).unwrap();
        assert_eq!(
            tokio::time::timeout(Duration::from_millis(10), attempt)
                .await
                .unwrap(),
            Err("Alloha вернул 500".into())
        );
    }

    #[test]
    fn feeds_can_only_supply_supported_public_literal_endpoints() {
        assert!(parse_endpoint("http://8.8.8.8:3128").is_some());
        assert!(parse_endpoint("https://8.8.8.8:3128").is_some());
        assert_eq!(
            parse_endpoint("socks4://8.8.8.8:1080").unwrap().scheme,
            "socks4a"
        );
        assert_eq!(
            parse_endpoint("socks5://8.8.8.8:1080").unwrap().scheme,
            "socks5h"
        );
        assert!(parse_endpoint("[2606:4700::1111]:8080").is_some());
        for line in [
            "http://user:password@8.8.8.8:3128",
            "ftp://8.8.8.8:3128",
            "127.0.0.1:8080",
            "169.254.169.254:80",
            "100.64.0.1:80",
            "[::ffff:127.0.0.1]:80",
            "[fc00::1]:80",
            "[2002:7f00:1::1]:80",
            "example.org:8080",
        ] {
            assert!(parse_endpoint(line).is_none(), "{line}");
        }
    }

    #[test]
    fn refresh_deduplicates_without_dropping_pending_addresses() {
        let first = parse_endpoint("8.8.8.8:3128").unwrap();
        let second = parse_endpoint("1.1.1.1:8080").unwrap();
        let third = parse_endpoint("9.9.9.9:80").unwrap();
        let mut queue = VecDeque::from([second, third]);
        update_queue(&mut queue, &[vec![first, second], vec![first]]);
        assert_eq!(queue, VecDeque::from([second, first]));

        queue.clear();
        update_queue(&mut queue, &[vec![first, second, second], vec![first]]);
        assert_eq!(queue, VecDeque::from([first, second]));
    }

    #[test]
    fn a_successful_probe_requires_the_app_manifest() {
        assert!(valid_probe(include_bytes!(
            "../../public/manifest.webmanifest"
        )));
        assert!(!valid_probe(b"<html>OK</html>"));
        assert!(!valid_probe(br#"{"short_name":"YummyWatch"}"#));
    }

    #[test]
    fn routes_prefer_recent_success_and_keep_failures_specific_to_each_provider() {
        let client = Client::new();
        let mut state = PoolState::default();
        let now = Instant::now();
        let public = |raw| Route::Public(parse_endpoint(raw).unwrap());
        let preferred = public("8.8.8.8:3128");
        let fast = public("1.1.1.1:8080");
        let failed = public("4.2.2.1:80");
        let stale = public("9.9.9.9:80");
        for (address, checked, millis) in [
            (preferred, now, 1000),
            (fast, now, 100),
            (failed, now, 50),
            (stale, now - VERIFIED_TTL, 1),
        ] {
            state.verified.insert(
                address,
                Verified {
                    client: client.clone(),
                    checked,
                    latency: Duration::from_millis(millis),
                },
            );
        }
        let kodik = state.providers.entry("kodik").or_default();
        kodik.last_success = Some(preferred);
        kodik.failed.insert(failed, now);
        let routes: Vec<_> = state
            .routes("kodik", &HashSet::new(), 3)
            .into_iter()
            .map(|(address, _)| address)
            .collect();
        assert_eq!(routes, [preferred, fast]);
        assert!(!state.verified.contains_key(&stale));
        assert_eq!(state.routes("aksor", &HashSet::new(), 1)[0].0, failed);
    }

    #[tokio::test(start_paused = true)]
    async fn retries_beyond_the_first_batch_and_picks_up_newly_verified_routes() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let pool = Pool::new(None);
        let seed = |port| {
            let address = format!("8.8.8.8:{port}");
            pool.state.lock().unwrap().verified.insert(
                Route::Public(parse_endpoint(&address).unwrap()),
                Verified {
                    client: Client::new(),
                    checked: Instant::now(),
                    latency: Duration::from_millis(port),
                },
            );
            pool.ready.notify_waiters();
        };
        for port in 3000..3003 {
            seed(port);
        }
        let calls = AtomicUsize::new(0);
        let resolution = pool.retry(
            "kodik",
            "Источник вернул HTTP 500.".into(),
            |_| async {
                match calls.fetch_add(1, Ordering::Relaxed) {
                    0..=2 => Err("Источник вернул HTTP 500.".into()),
                    _ => Ok("кодик"),
                }
            },
        );
        let (result, ()) = tokio::join!(resolution, async {
            tokio::time::sleep(Duration::from_secs(1)).await;
            seed(3003);
        });
        assert_eq!(result, Ok("кодик"));
        assert_eq!(calls.load(Ordering::Relaxed), 4);
        let report = pool.report(None, false).unwrap();
        assert_eq!(
            (
                report.players[0].0,
                report.players[0].1,
                report.players[0].2
            ),
            ("Kodik", 4, 1)
        );
        assert!(report.players[0].3.is_some());
        assert_eq!(report.players[1], ("Aksor", 0, 0, None));
    }
}

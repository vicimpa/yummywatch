#[cfg(target_os = "android")]
#[path = "android.rs"]
mod android;
#[path = "mpv.rs"]
mod mpv;
#[path = "relay.rs"]
mod relay;

use serde::{Deserialize, Serialize};
use std::{
    collections::{hash_map::Entry, HashMap},
    ffi::CString,
    sync::{Arc, Mutex, OnceLock},
};
use tauri::ipc::Response;
use tauri::{async_runtime::spawn_blocking, Manager, WebviewWindow};

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase")]
pub enum Request {
    Open {
        id: u32,
        url: String,
        kind: Kind,
        caption: Option<String>,
        start: f64,
    },
    Poll {
        id: u32,
        controls: Controls,
        #[cfg(target_os = "android")]
        visible: Option<bool>,
        #[cfg(target_os = "android")]
        geometry: Option<Geometry>,
    },
    Close {
        id: u32,
    },
}

#[cfg(target_os = "android")]
#[derive(Clone, Copy, Default, Deserialize)]
pub struct Geometry {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Hls,
    Mp4,
    Dash,
}

impl Kind {
    fn extension(self) -> &'static str {
        match self {
            Self::Hls => "m3u8",
            Self::Mp4 => "mp4",
            Self::Dash => "mpd",
        }
    }
}

#[derive(Default, Deserialize)]
pub struct Controls {
    pause: Option<bool>,
    mute: Option<bool>,
    seconds: Option<f64>,
    volume: Option<f64>,
    speed: Option<f64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    position: f64,
    duration: f64,
    buffered: f64,
    frame_width: i64,
    frame_height: i64,
    ready: bool,
    seeking: bool,
    buffering: bool,
    ended: bool,
    failure: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    failure_message: Option<String>,
    paused: Option<bool>,
}

struct Session {
    player: Mutex<Option<mpv::Player>>,
    position: Mutex<Option<f64>>,
    #[cfg(target_os = "android")]
    layout: Mutex<(bool, Geometry)>,
}

#[cfg(target_os = "android")]
async fn release_surface(window: &WebviewWindow, id: u32, session: Option<Arc<Session>>) {
    if let Some(session) = session {
        let _ = spawn_blocking(move || {
            let player = session.player.lock().unwrap().take();
            drop(player);
        })
        .await;
    }
    android::close(window, id).await;
}

#[derive(Default)]
struct Sessions {
    generation: u64,
    players: HashMap<u32, Option<Arc<Session>>>,
}

fn sessions() -> &'static Mutex<Sessions> {
    static SESSIONS: OnceLock<Mutex<Sessions>> = OnceLock::new();
    SESSIONS.get_or_init(Mutex::default)
}

fn session(id: u32) -> Option<Arc<Session>> {
    sessions().lock().unwrap().players.get(&id)?.clone()
}

fn drain_players() -> HashMap<u32, Option<Arc<Session>>> {
    let mut sessions = sessions().lock().unwrap();
    sessions.generation = sessions.generation.wrapping_add(1);
    std::mem::take(&mut sessions.players)
}

pub fn clear() {
    let players = drain_players();
    spawn_blocking(move || drop(players));
}

#[cfg(target_os = "android")]
pub fn clear_webview(window: WebviewWindow) {
    let players = drain_players();
    tauri::async_runtime::spawn(async move {
        for (id, player) in players {
            release_surface(&window, id, player).await;
        }
    });
}

#[cfg(not(target_os = "android"))]
pub fn closing_positions() -> HashMap<u32, f64> {
    sessions()
        .lock()
        .unwrap()
        .players
        .iter()
        .filter_map(|(&id, player)| Some((id, (*player.as_ref()?.position.lock().unwrap())?)))
        .collect()
}

#[cfg(target_os = "android")]
pub fn available() -> bool {
    mpv::android_api().is_ok()
}

#[cfg(target_os = "android")]
fn api(_: &WebviewWindow) -> Result<&'static mpv::Api, String> {
    mpv::android_api()
}

#[cfg(target_os = "linux")]
fn api(_: &WebviewWindow) -> Result<&'static mpv::Api, String> {
    Ok(&mpv::API)
}

#[cfg(target_os = "windows")]
fn api(window: &WebviewWindow) -> Result<&'static mpv::Api, String> {
    let path = if cfg!(debug_assertions) {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("native-libs/windows/libmpv-2.dll")
    } else {
        window
            .path()
            .resource_dir()
            .map_err(|error| error.to_string())?
            .join("libmpv")
            .join("libmpv-2.dll")
    };
    mpv::windows_api(&path)
}

#[tauri::command]
pub async fn native_video(
    window: WebviewWindow,
    request: Request,
) -> Result<Option<Snapshot>, String> {
    if window.label() != "main" {
        return Err("Неизвестное окно.".into());
    }

    match request {
        Request::Open {
            id,
            url,
            kind,
            caption,
            start,
        } => {
            let generation = sessions().lock().unwrap().generation;
            let backend = window.state::<crate::backend::Backend>();
            let (url, kind) = match url::Url::parse(&url) {
                Ok(manifest)
                    if matches!(kind, Kind::Dash)
                        && crate::providers::is_aksor_media_url(&manifest) =>
                {
                    // Use the relay to supply the same headers to every fragment.
                    (backend.aksor_hls(manifest).await?, Kind::Hls)
                }
                _ => (url, kind),
            };
            let (url, relayed) = relay::media_url(&backend, &url, kind.extension()).await?;
            let url = CString::new(url).map_err(|_| "Некорректный адрес видео.")?;
            let caption = match caption {
                Some(caption) => Some(
                    CString::new(relay::media_url(&backend, &caption, "vtt").await?.0)
                        .map_err(|_| "Некорректный адрес субтитров.")?,
                ),
                None => None,
            };
            {
                let mut sessions = sessions().lock().unwrap();
                if sessions.generation != generation {
                    return Err("Окно видеоплеера закрыто.".into());
                }
                if sessions.players.len() >= 4 {
                    return Err("Слишком много открытых видеопотоков.".into());
                }
                match sessions.players.entry(id) {
                    Entry::Vacant(slot) => {
                        slot.insert(None);
                    }
                    Entry::Occupied(_) => return Err("Видеопоток уже открыт.".into()),
                }
            }
            #[cfg(target_os = "android")]
            let surface = match android::open(&window, id).await {
                Ok(surface) => surface,
                Err(error) => {
                    sessions().lock().unwrap().players.remove(&id);
                    android::close(&window, id).await;
                    return Err(error);
                }
            };
            #[cfg(target_os = "android")]
            let owner = window.clone();
            let result = spawn_blocking(move || {
                let result = api(&window).and_then(|api| {
                    mpv::Player::open(
                        api,
                        &url,
                        caption,
                        start,
                        relayed && matches!(kind, Kind::Hls),
                        false,
                        #[cfg(target_os = "android")]
                        surface,
                    )
                });
                let mut sessions = sessions().lock().unwrap();
                if sessions.generation != generation {
                    drop(sessions);
                    return Err("Окно видеоплеера закрыто.".into());
                }
                let Entry::Occupied(mut slot) = sessions.players.entry(id) else {
                    drop(sessions);
                    return Err("Видеопоток закрыт.".into());
                };
                match result {
                    Ok(player) => {
                        slot.insert(Some(Arc::new(Session {
                            player: Mutex::new(Some(player)),
                            position: Mutex::new(None),
                            #[cfg(target_os = "android")]
                            layout: Mutex::default(),
                        })));
                        Ok(None)
                    }
                    Err(error) => {
                        slot.remove();
                        Err(error)
                    }
                }
            })
            .await
            .map_err(|error| error.to_string())?;
            #[cfg(target_os = "android")]
            if result.is_err() {
                android::close(&owner, id).await;
            }
            result
        }
        Request::Poll {
            id,
            controls,
            #[cfg(target_os = "android")]
            visible,
            #[cfg(target_os = "android")]
            geometry,
        } => {
            let session = session(id).ok_or("Видеопоток закрыт.")?;
            #[cfg(target_os = "android")]
            if visible.is_some() || geometry.is_some() {
                let (visible, geometry) = {
                    let mut layout = session.layout.lock().unwrap();
                    if let Some(visible) = visible {
                        layout.0 = visible;
                    }
                    if let Some(geometry) = geometry {
                        layout.1 = geometry;
                    }
                    *layout
                };
                android::layout(&window, id, visible, geometry).await?;
            }
            spawn_blocking(move || {
                let mut player = session.player.lock().unwrap();
                let result = player.as_mut()?.poll(controls);
                if result.ready && !result.seeking && !result.failure {
                    *session.position.lock().unwrap() = Some(result.position);
                }
                Some(result)
            })
            .await
            .map_err(|error| error.to_string())
        }
        Request::Close { id } => {
            let player = sessions().lock().unwrap().players.remove(&id);
            #[cfg(not(target_os = "android"))]
            spawn_blocking(move || drop(player));
            #[cfg(target_os = "android")]
            release_surface(&window, id, player.flatten()).await;
            Ok(None)
        }
    }
}

#[cfg(target_os = "android")]
#[tauri::command]
pub async fn native_video_frame(
    window: WebviewWindow,
    id: u32,
    close: bool,
) -> Result<Response, String> {
    if window.label() != "main" {
        return Err("Неизвестное окно.".into());
    }
    let frame = if session(id).is_some() {
        android::frame(&window, id).await
    } else {
        Ok(Vec::new())
    };
    if close {
        let player = sessions().lock().unwrap().players.remove(&id).flatten();
        release_surface(&window, id, player).await;
    }
    frame.map(Response::new)
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn native_video_pixels(
    window: WebviewWindow,
    id: u32,
    width: i32,
    height: i32,
) -> Result<Response, String> {
    if window.label() != "main" {
        return Err("Неизвестное окно.".into());
    }
    if !(16..=1920).contains(&width) || width % 16 != 0 || !(1..=1080).contains(&height) {
        return Err("Недопустимый размер видеокадра.".into());
    }
    let pixels = match session(id) {
        Some(session) => spawn_blocking(move || {
            session
                .player
                .lock()
                .unwrap()
                .as_mut()
                .map_or_else(Vec::new, |player| player.pixels([width, height]))
        })
        .await
        .map_err(|error| error.to_string())?,
        None => Vec::new(),
    };
    Ok(Response::new(pixels))
}

#[cfg(all(test, not(target_os = "android")))]
mod tests {
    use super::*;
    use std::{
        thread,
        time::{Duration, Instant},
    };

    #[test]
    fn libmpv_renders_and_seeks_a_paused_stream() {
        #[cfg(target_os = "linux")]
        let api = &mpv::API;
        #[cfg(target_os = "windows")]
        let api = mpv::windows_api(
            &std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("native-libs/windows/libmpv-2.dll"),
        )
        .unwrap();

        let file = std::env::temp_dir().join(format!("yummywatch-{}.mp4", crate::alloha::token()));
        // The H.264 picture changes from dark to bright after the first second.
        std::fs::write(&file, include_bytes!("fixtures/playback.mp4")).unwrap();
        let path = CString::new(file.to_str().unwrap()).unwrap();
        let mut player = mpv::Player::open(api, &path, None, 0.0, false, true).unwrap();

        let check_frame =
            |player: &mut mpv::Player, position: f64, brightness: std::ops::Range<u8>| {
                let deadline = Instant::now() + Duration::from_secs(5);
                let mut last = Vec::new();
                while Instant::now() < deadline {
                    let pixels = player.pixels([32, 16]);
                    if !pixels.is_empty() {
                        last = pixels;
                    }
                    let state = player.poll(Controls::default());
                    assert!(!state.failure);
                    if state.ready
                        && !state.seeking
                        && (state.position - position).abs() < 0.2
                        && !last.is_empty()
                    {
                        let pixel = &last[4 * (8 * 32 + 16)..][..4];
                        if brightness.contains(&pixel[0]) {
                            assert_eq!(pixel[3], 255);
                            assert_eq!(state.paused, Some(true));
                            assert_eq!([state.frame_width, state.frame_height], [32, 16]);
                            return;
                        }
                    }
                    thread::sleep(Duration::from_millis(10));
                }
                panic!("libmpv did not render the expected frame at {position}s");
            };
        check_frame(&mut player, 0.0, 20..110);
        player.poll(Controls {
            seconds: Some(2.0),
            ..Default::default()
        });
        check_frame(&mut player, 2.0, 145..240);
        drop(player);
        std::fs::remove_file(file).unwrap();
    }
}

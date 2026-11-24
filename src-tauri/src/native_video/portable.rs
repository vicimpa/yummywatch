#[cfg(target_os = "android")]
#[path = "android.rs"]
mod android;
#[path = "mpv.rs"]
mod mpv;
#[path = "relay.rs"]
mod relay;
#[cfg(target_os = "linux")]
#[path = "linux_surface.rs"]
mod surface;
#[cfg(target_os = "windows")]
#[path = "windows_surface.rs"]
mod surface;

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
        visible: Option<bool>,
        geometry: Option<Geometry>,
    },
    Close {
        id: u32,
    },
}

#[derive(Clone, Copy, Default, Deserialize)]
pub struct Geometry {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[cfg(desktop)]
impl Geometry {
    fn bounds(self, width: i32, height: i32) -> [i32; 4] {
        let pixel =
            |value: f64, size: i32| (value.clamp(0.0, 1.0) * f64::from(size)).round() as i32;
        let x = pixel(self.x, width);
        let y = pixel(self.y, height);
        [
            x,
            y,
            (pixel(self.x + self.width, width) - x).max(1),
            (pixel(self.y + self.height, height) - y).max(1),
        ]
    }
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
    player: Arc<Mutex<Option<mpv::Player>>>,
    position: Mutex<Option<f64>>,
    layout: Mutex<(bool, Geometry)>,
}

#[cfg(desktop)]
async fn on_main<T: Send + 'static>(
    window: &WebviewWindow,
    action: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    let (send, receive) = tokio::sync::oneshot::channel();
    window
        .run_on_main_thread(move || {
            let _ = send.send(action());
        })
        .map_err(|error| error.to_string())?;
    receive.await.map_err(|error| error.to_string())
}

async fn release_surface(window: &WebviewWindow, id: u32, session: Option<Arc<Session>>) {
    #[cfg(target_os = "linux")]
    let _ = on_main(window, move || surface::close(id)).await;
    if let Some(session) = session {
        let _ = spawn_blocking(move || {
            let player = session.player.lock().unwrap().take();
            drop(player);
        })
        .await;
    }
    #[cfg(target_os = "android")]
    android::close(window, id).await;
    #[cfg(target_os = "windows")]
    let _ = on_main(window, move || surface::close(id)).await;
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
    #[cfg(desktop)]
    for id in players.keys() {
        surface::close(*id);
    }
    spawn_blocking(move || drop(players));
}

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
            let session = Arc::new(Session {
                player: Arc::new(Mutex::new(None)),
                position: Mutex::new(None),
                layout: Mutex::default(),
            });
            let relayed_hls = relayed && matches!(kind, Kind::Hls);
            let opened = async {
                #[cfg(target_os = "linux")]
                {
                    let player = session.player.clone();
                    let (send, receive) = tokio::sync::oneshot::channel();
                    window
                        .with_webview(move |view| {
                            let result = surface::open(id, &view.inner(), &player, |gl| {
                                mpv::Player::open(
                                    &mpv::API,
                                    &url,
                                    caption,
                                    start,
                                    relayed_hls,
                                    false,
                                    mpv::DesktopOutput::OpenGl(gl),
                                )
                            });
                            let _ = send.send(result);
                        })
                        .map_err(|error| error.to_string())?;
                    receive.await.map_err(|error| error.to_string())??;
                }
                #[cfg(any(target_os = "windows", target_os = "android"))]
                {
                    #[cfg(target_os = "android")]
                    let output = android::open(&window, id).await?;
                    #[cfg(target_os = "windows")]
                    let output = {
                        let parent = window.hwnd().map_err(|error| error.to_string())?.0 as usize;
                        let host = on_main(&window, move || surface::open(id, parent)).await??;
                        mpv::DesktopOutput::Window(host)
                    };
                    let owner = window.clone();
                    let player = session.player.clone();
                    spawn_blocking(move || {
                        let result = mpv::Player::open(
                            api(&owner)?,
                            &url,
                            caption,
                            start,
                            relayed_hls,
                            false,
                            output,
                        )?;
                        *player.lock().unwrap() = Some(result);
                        Ok::<(), String>(())
                    })
                    .await
                    .map_err(|error| error.to_string())??;
                }
                Ok::<(), String>(())
            }
            .await;
            let result = (|| {
                let mut sessions = sessions().lock().unwrap();
                if sessions.generation != generation {
                    return Err("Окно видеоплеера закрыто.".into());
                }
                let Entry::Occupied(mut slot) = sessions.players.entry(id) else {
                    return Err("Видеопоток закрыт.".into());
                };
                match opened {
                    Ok(()) => {
                        slot.insert(Some(session.clone()));
                        Ok(None)
                    }
                    Err(error) => {
                        slot.remove();
                        Err(error)
                    }
                }
            })();
            if result.is_err() {
                release_surface(&window, id, Some(session)).await;
            }
            result
        }
        Request::Poll {
            id,
            controls,
            visible,
            geometry,
        } => {
            let session = session(id).ok_or("Видеопоток закрыт.")?;
            if cfg!(desktop) || visible.is_some() || geometry.is_some() {
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
                #[cfg(target_os = "android")]
                android::layout(&window, id, visible, geometry).await?;
                #[cfg(desktop)]
                on_main(&window, move || surface::layout(id, visible, geometry)).await?;
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
            let session = sessions().lock().unwrap().players.remove(&id).flatten();
            release_surface(&window, id, session).await;
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

#[cfg(desktop)]
#[tauri::command]
pub async fn native_video_frame(
    window: WebviewWindow,
    id: u32,
    close: bool,
) -> Result<Response, String> {
    if window.label() != "main" {
        return Err("Неизвестное окно.".into());
    }
    let session = if close {
        sessions().lock().unwrap().players.remove(&id).flatten()
    } else {
        session(id)
    };
    let Some(session) = session else {
        return Ok(Response::new(Vec::new()));
    };
    let player = session.player.clone();
    let frame = spawn_blocking(move || {
        player
            .lock()
            .unwrap()
            .as_mut()
            .map_or_else(Vec::new, mpv::Player::screenshot)
    })
    .await;
    if close {
        release_surface(&window, id, Some(session)).await;
    }
    frame.map(Response::new).map_err(|error| error.to_string())
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
        let mut player = mpv::Player::open(
            api,
            &path,
            None,
            0.0,
            false,
            true,
            mpv::DesktopOutput::Software,
        )
        .unwrap();

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
        assert!(player.screenshot().starts_with(&[0xff, 0xd8]));
        drop(player);
        std::fs::remove_file(file).unwrap();
    }
}

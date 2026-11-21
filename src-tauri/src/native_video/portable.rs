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
use tauri::{async_runtime::spawn_blocking, ipc::Response, Manager, WebviewWindow};

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
    },
    Close {
        id: u32,
    },
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
    paused: Option<bool>,
}

struct Session {
    player: Mutex<mpv::Player>,
    position: Mutex<Option<f64>>,
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

pub fn clear() {
    let players = {
        let mut sessions = sessions().lock().unwrap();
        sessions.generation = sessions.generation.wrapping_add(1);
        std::mem::take(&mut sessions.players)
    };
    spawn_blocking(move || drop(players));
}

pub fn closing_positions() -> HashMap<u32, f64> {
    sessions()
        .lock()
        .unwrap()
        .players
        .iter()
        .filter_map(|(&id, player)| Some((id, (*player.as_ref()?.position.lock().unwrap())?)))
        .collect()
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
            spawn_blocking(move || {
                let result = api(&window).and_then(|api| {
                    mpv::Player::open(
                        api,
                        &url,
                        caption,
                        start,
                        relayed && matches!(kind, Kind::Hls),
                        false,
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
                            player: Mutex::new(player),
                            position: Mutex::new(None),
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
            .map_err(|error| error.to_string())?
        }
        Request::Poll { id, controls } => {
            let session = session(id).ok_or("Видеопоток закрыт.")?;
            spawn_blocking(move || {
                let result = session.player.lock().unwrap().poll(controls);
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
            spawn_blocking(move || drop(player));
            Ok(None)
        }
    }
}

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
        Some(session) => {
            spawn_blocking(move || session.player.lock().unwrap().pixels([width, height]))
                .await
                .map_err(|error| error.to_string())?
        }
        None => Vec::new(),
    };
    Ok(Response::new(pixels))
}

#[cfg(test)]
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

mod protocol;
mod relay;

use serde::{Deserialize, Serialize};
use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    ffi::{c_char, c_void, CStr, CString},
    ptr::{self, NonNull},
};
use tauri::Manager;
use tokio::sync::oneshot;

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase")]
pub enum Request {
    Open {
        id: u32,
        url: String,
        kind: Kind,
        caption: Option<String>,
        preview: Option<PreviewSource>,
        start: f64,
        #[serde(default)]
        upscale: UpscaleMode,
        sharpen: Option<SharpenSetting>,
    },
    Poll {
        id: u32,
        controls: Controls,
        geometry: Option<Geometry>,
        visible: Option<bool>,
        active: Option<bool>,
        upscale: Option<UpscaleMode>,
        sharpen: Option<SharpenSetting>,
    },
    PictureInPicture {
        enabled: Option<bool>,
        unavailable: Option<bool>,
    },
    PictureInPictureCard {
        visible: bool,
    },
    Close {
        id: u32,
    },
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum UpscaleMode {
    #[default]
    Default,
    EwaLanczos,
    Fsr,
    Anime4k,
    Fsrcnnx,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SharpenLevel {
    Off,
    Moderate,
    Strong,
}

#[derive(Deserialize)]
#[serde(untagged)]
pub enum SharpenSetting {
    Level(SharpenLevel),
    Legacy(bool),
}

struct UpscaleOptions {
    scale: &'static CStr,
    shader: Option<CString>,
    sharpen: Option<CString>,
    strong: bool,
}

impl UpscaleMode {
    fn options(
        self,
        window: &tauri::WebviewWindow,
        sharpen: Option<SharpenSetting>,
    ) -> UpscaleOptions {
        let level = match sharpen {
            Some(SharpenSetting::Level(level)) => level,
            Some(SharpenSetting::Legacy(true)) => SharpenLevel::Moderate,
            _ => SharpenLevel::Off,
        };
        let shader_path = |name| {
            let path = window
                .path()
                .resource_dir()
                .ok()?
                .join("upscaling")
                .join(name);
            CString::new(path.as_os_str().as_encoded_bytes()).ok()
        };
        let shader = match self {
            Self::Default | Self::EwaLanczos => None,
            Self::Fsr => Some("FSR.glsl"),
            Self::Anime4k => Some("Anime4K_Upscale_CNN_x2_S.glsl"),
            Self::Fsrcnnx => Some("FSRCNNX_x2_8-0-4-1.glsl"),
        }
        .and_then(shader_path);
        UpscaleOptions {
            scale: if matches!(self, Self::Default) {
                c"lanczos"
            } else {
                c"ewa_lanczos"
            },
            shader,
            sharpen: (!matches!(level, SharpenLevel::Off))
                .then_some("UpscaleSharpen.glsl")
                .and_then(shader_path),
            strong: matches!(level, SharpenLevel::Strong),
        }
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

    fn demuxer(self) -> &'static CStr {
        match self {
            Self::Hls => c"hls",
            Self::Mp4 => c"mov",
            Self::Dash => c"dash",
        }
    }
}

#[derive(Deserialize)]
pub struct PreviewSource {
    url: String,
    kind: Kind,
}

#[derive(Deserialize)]
pub struct Geometry {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

impl Geometry {
    fn bounds(self) -> Option<[f64; 4]> {
        let bounds = [self.x, self.y, self.width, self.height];
        (bounds
            .iter()
            .all(|value| value.is_finite() && value.abs() <= 4.0)
            && self.width >= 0.0
            && self.height >= 0.0)
            .then_some(bounds)
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

#[derive(Default)]
#[repr(C)]
struct RawSnapshot {
    position: f64,
    duration: f64,
    buffered: f64,
    ready: i32,
    seeking: i32,
    buffering: i32,
    ended: i32,
    failure: i32,
    paused: i32,
}

#[derive(Serialize)]
pub struct Snapshot {
    position: f64,
    duration: f64,
    buffered: f64,
    ready: bool,
    seeking: bool,
    buffering: bool,
    ended: bool,
    failure: bool,
    paused: Option<bool>,
}

extern "C" {
    fn yw_video_check_bundled_library(media_io: *const protocol::MediaIO) -> bool;
    fn yw_video_open(
        webview: *mut c_void,
        library: *const c_char,
        url: *const c_char,
        caption: *const c_char,
        kind: *const c_char,
        referrer: *const c_char,
        start: f64,
        media_io: *const protocol::MediaIO,
        scale: *const c_char,
        shader: *const c_char,
        sharpen: *const c_char,
        strong: bool,
        error: *mut *const c_char,
    ) -> *mut c_void;
    fn yw_video_close(player: *mut c_void);
    fn yw_video_picture_in_picture(
        webview: *mut c_void,
        player: *mut c_void,
        enabled: bool,
    ) -> bool;
    fn yw_video_attach_picture_in_picture(player: *mut c_void);
    fn yw_video_picture_in_picture_unavailable(unavailable: bool);
    fn yw_video_picture_in_picture_card(visible: bool);
    fn yw_video_picture_in_picture_card_frame(
        context: *mut c_void,
        complete: unsafe extern "C" fn(*mut c_void, *const u8, usize),
    );
    fn yw_video_set_thumbnail_source(
        player: *mut c_void,
        url: *const c_char,
        kind: *const c_char,
        referrer: *const c_char,
    );
    fn yw_video_frame(
        player: *mut c_void,
        context: *mut c_void,
        complete: unsafe extern "C" fn(*mut c_void, *const u8, usize),
    );
    fn yw_video_thumbnail(
        player: *mut c_void,
        seconds: f64,
        context: *mut c_void,
        complete: unsafe extern "C" fn(*mut c_void, *const u8, usize),
    );
    fn yw_video_layout(player: *mut c_void, rect: *const f64, visibility: i32);
    fn yw_video_upscale(
        player: *mut c_void,
        scale: *const c_char,
        shader: *const c_char,
        sharpen: *const c_char,
        strong: bool,
    );
    fn yw_video_flag(player: *mut c_void, name: *const c_char, value: i32);
    fn yw_video_number(player: *mut c_void, name: *const c_char, value: f64);
    fn yw_video_snapshot(player: *mut c_void, snapshot: *mut RawSnapshot);
}

pub fn check_bundled_library() -> bool {
    unsafe { yw_video_check_bundled_library(&protocol::MEDIA_IO) }
}

struct Player(NonNull<c_void>);

impl Player {
    fn poll(
        &self,
        controls: Controls,
        geometry: Option<Geometry>,
        visible: Option<bool>,
    ) -> Snapshot {
        let player = self.0.as_ptr();
        let rect = geometry.and_then(Geometry::bounds);
        // Player and WebView pointers are used only on the AppKit main thread.
        unsafe {
            if rect.is_some() || visible.is_some() {
                yw_video_layout(
                    player,
                    rect.as_ref().map_or(ptr::null(), |rect| rect.as_ptr()),
                    visible.map_or(-1, i32::from),
                );
            }
            for (name, value) in [
                (
                    c"volume",
                    controls.volume.map(|v| v.clamp(0.0, 1.0) * 100.0),
                ),
                (c"speed", controls.speed.map(|v| v.clamp(0.375, 2.5))),
                (c"time-pos", controls.seconds.map(|v| v.clamp(0.0, 86400.0))),
            ] {
                if let Some(value) = value.filter(|v| v.is_finite()) {
                    yw_video_number(player, name.as_ptr(), value);
                }
            }
            for (name, value) in [(c"mute", controls.mute), (c"pause", controls.pause)] {
                if let Some(value) = value {
                    yw_video_flag(player, name.as_ptr(), i32::from(value));
                }
            }
            let mut raw = RawSnapshot::default();
            yw_video_snapshot(player, &mut raw);
            Snapshot {
                position: raw.position,
                duration: raw.duration,
                buffered: raw.buffered,
                ready: raw.ready != 0,
                seeking: raw.seeking != 0,
                buffering: raw.buffering != 0,
                ended: raw.ended != 0,
                failure: raw.failure != 0,
                paused: (raw.paused >= 0).then_some(raw.paused != 0),
            }
        }
    }
}

impl Drop for Player {
    fn drop(&mut self) {
        unsafe { yw_video_close(self.0.as_ptr()) }
    }
}

thread_local! {
    static PLAYERS: RefCell<HashMap<u32, Player>> = RefCell::new(HashMap::new());
    static ACTIVE: Cell<Option<u32>> = const { Cell::new(None) };
}

pub fn clear() {
    unsafe {
        yw_video_picture_in_picture(ptr::null_mut(), ptr::null_mut(), false);
        yw_video_picture_in_picture_unavailable(false);
    }
    ACTIVE.with(|active| active.set(None));
    PLAYERS.with(|players| players.borrow_mut().clear());
}

pub fn closing_positions() -> HashMap<u32, f64> {
    PLAYERS.with(|players| {
        players
            .borrow()
            .iter()
            .filter_map(|(&id, player)| {
                let state = player.poll(Controls::default(), None, None);
                (state.ready && !state.seeking && !state.failure).then_some((id, state.position))
            })
            .collect()
    })
}

fn for_view(
    window: &tauri::WebviewWindow,
    action: impl FnOnce(*mut c_void) -> Result<Option<Snapshot>, String> + Send + 'static,
) -> Result<oneshot::Receiver<Result<Option<Snapshot>, String>>, String> {
    let (sender, receiver) = oneshot::channel();
    window
        .with_webview(move |webview| {
            let _ = sender.send(action(webview.inner()));
        })
        .map_err(|error| error.to_string())?;
    Ok(receiver)
}

async fn player_url(
    backend: &crate::backend::Backend,
    url: &str,
    kind: Kind,
) -> Result<(CString, Kind), String> {
    // FFmpeg's DASH demuxer opens child segments over HTTP(S). Use the
    // existing loopback transport for DASH so it sees the shared disk cache.
    if matches!(kind, Kind::Dash) {
        let (url, kind) = match url::Url::parse(url) {
            Ok(manifest) if crate::providers::is_aksor_media_url(&manifest) => {
                (backend.aksor_hls(manifest).await?, Kind::Hls)
            }
            _ => (url.to_owned(), kind),
        };
        let (url, _) = relay::media_url(backend, &url, kind.extension()).await?;
        let url = CString::new(url).map_err(|_| "Некорректный адрес видео.")?;
        return Ok((url, kind));
    }
    Ok((protocol::url(url, kind.extension())?, kind))
}

#[tauri::command]
pub async fn native_video(
    window: tauri::WebviewWindow,
    request: Request,
) -> Result<Option<Snapshot>, String> {
    if window.label() != "main" {
        return Err("Неизвестное окно.".into());
    }
    let response = match request {
        Request::Open {
            id,
            url,
            kind,
            caption,
            preview,
            start,
            upscale,
            sharpen,
        } => {
            let backend = window.state::<crate::backend::Backend>();
            protocol::init(&backend);
            let (url, kind) = player_url(&backend, &url, kind).await?;
            let preview = if let Some(preview) = preview {
                player_url(&backend, &preview.url, preview.kind).await.ok()
            } else {
                None
            };
            let caption = caption
                .as_deref()
                .map(|url| protocol::url(url, "vtt"))
                .transpose()?;
            let upscale = upscale.options(&window, sharpen);
            for_view(&window, move |view| {
                PLAYERS.with(|players| {
                    let mut players = players.borrow_mut();
                    if players.len() >= 4 {
                        return Err("Слишком много открытых видеопотоков.".into());
                    }
                    #[cfg(debug_assertions)]
                    let library = std::env::var("YUMIWATCH_LIBMPV").unwrap_or_else(|_| {
                        concat!(
                            env!("CARGO_MANIFEST_DIR"),
                            "/native-libs/macos/libmpv.2.dylib"
                        )
                        .into()
                    });
                    #[cfg(debug_assertions)]
                    let library = CString::new(library).ok();
                    #[cfg(not(debug_assertions))]
                    let library: Option<CString> = None;
                    let mut error = ptr::null();
                    let referrer = crate::providers::native_aksor_referrer(&url);
                    let player = unsafe {
                        yw_video_open(
                            view,
                            library.as_ref().map_or(ptr::null(), |path| path.as_ptr()),
                            url.as_ptr(),
                            caption.as_ref().map_or(ptr::null(), |url| url.as_ptr()),
                            kind.demuxer().as_ptr(),
                            referrer.as_deref().map_or(ptr::null(), CStr::as_ptr),
                            start.clamp(0.0, 86400.0),
                            &protocol::MEDIA_IO,
                            upscale.scale.as_ptr(),
                            upscale.shader.as_deref().map_or(ptr::null(), CStr::as_ptr),
                            upscale.sharpen.as_deref().map_or(ptr::null(), CStr::as_ptr),
                            upscale.strong,
                            &mut error,
                        )
                    };
                    let player = NonNull::new(player).ok_or_else(|| {
                        // The native bridge returns a static, NUL-terminated error on failure.
                        unsafe { CStr::from_ptr(error) }
                            .to_string_lossy()
                            .into_owned()
                    })?;
                    if let Some((url, kind)) = preview {
                        let referrer = crate::providers::native_aksor_referrer(&url);
                        unsafe {
                            yw_video_set_thumbnail_source(
                                player.as_ptr(),
                                url.as_ptr(),
                                kind.demuxer().as_ptr(),
                                referrer.as_deref().map_or(ptr::null(), CStr::as_ptr),
                            );
                        }
                    }
                    players.insert(id, Player(player));
                    Ok(None)
                })
            })?
        }
        Request::Poll {
            id,
            controls,
            geometry,
            visible,
            active,
            upscale,
            sharpen,
        } => {
            let upscale = upscale.map(|mode| mode.options(&window, sharpen));
            for_view(&window, move |_| {
                PLAYERS.with(|players| {
                    let players = players.borrow();
                    let player = players.get(&id).ok_or("Видеопоток закрыт.")?;
                    if let Some(upscale) = upscale {
                        unsafe {
                            yw_video_upscale(
                                player.0.as_ptr(),
                                upscale.scale.as_ptr(),
                                upscale.shader.as_deref().map_or(ptr::null(), CStr::as_ptr),
                                upscale.sharpen.as_deref().map_or(ptr::null(), CStr::as_ptr),
                                upscale.strong,
                            );
                        }
                    }
                    ACTIVE.with(|current| match active {
                        Some(true) if current.get().is_none_or(|previous| id >= previous) => {
                            current.set(Some(id));
                            unsafe { yw_video_attach_picture_in_picture(player.0.as_ptr()) };
                        }
                        Some(false) if current.get() == Some(id) => {
                            current.set(None);
                            unsafe { yw_video_attach_picture_in_picture(ptr::null_mut()) };
                        }
                        _ => {}
                    });
                    Ok(Some(player.poll(controls, geometry, visible)))
                })
            })?
        }
        Request::PictureInPicture {
            enabled,
            unavailable,
        } => for_view(&window, move |view| {
            if let Some(unavailable) = unavailable {
                unsafe { yw_video_picture_in_picture_unavailable(unavailable) };
            }
            if let Some(enabled) = enabled {
                let success = PLAYERS.with(|players| {
                    let players = players.borrow();
                    let player = ACTIVE.with(Cell::get).and_then(|id| players.get(&id));
                    unsafe {
                        yw_video_picture_in_picture(
                            view,
                            player.map_or(ptr::null_mut(), |player| player.0.as_ptr()),
                            enabled,
                        )
                    }
                });
                if !success {
                    return Err("Не удалось открыть мини-плеер.".into());
                }
            }
            Ok(None)
        })?,
        Request::PictureInPictureCard { visible } => for_view(&window, move |_| {
            unsafe { yw_video_picture_in_picture_card(visible) };
            Ok(None)
        })?,
        Request::Close { id } => for_view(&window, move |_| {
            PLAYERS.with(|players| players.borrow_mut().remove(&id));
            Ok(None)
        })?,
    };
    response
        .await
        .map_err(|_| "Окно видеоплеера закрыто.".to_string())?
}

unsafe extern "C" fn complete_frame(context: *mut c_void, image: *const u8, length: usize) {
    send_frame(context, image, length, 256 * 1024);
}

unsafe extern "C" fn complete_card_frame(context: *mut c_void, image: *const u8, length: usize) {
    send_frame(context, image, length, 1024 * 1024);
}

unsafe fn send_frame(context: *mut c_void, image: *const u8, length: usize, limit: usize) {
    let sender = Box::from_raw(context.cast::<oneshot::Sender<Vec<u8>>>());
    let bytes = if !image.is_null() && (1..=limit).contains(&length) {
        std::slice::from_raw_parts(image, length).to_vec()
    } else {
        Vec::new()
    };
    let _ = sender.send(bytes);
}

#[tauri::command]
pub async fn native_video_card_frame(
    window: tauri::WebviewWindow,
) -> Result<tauri::ipc::Response, String> {
    if window.label() != "main" {
        return Err("Неизвестное окно.".into());
    }
    let (sender, receiver) = oneshot::channel::<Vec<u8>>();
    window
        .with_webview(move |_| unsafe {
            yw_video_picture_in_picture_card_frame(
                Box::into_raw(Box::new(sender)).cast(),
                complete_card_frame,
            );
        })
        .map_err(|error| error.to_string())?;
    Ok(tauri::ipc::Response::new(
        receiver.await.unwrap_or_default(),
    ))
}

#[tauri::command]
pub async fn native_video_frame(
    window: tauri::WebviewWindow,
    id: u32,
    close: bool,
    seconds: Option<f64>,
) -> Result<tauri::ipc::Response, String> {
    if window.label() != "main" {
        return Err("Неизвестное окно.".into());
    }
    if seconds.is_some_and(|time| close || !(0.0..=86400.0).contains(&time)) {
        return Err("Недопустимая позиция предпросмотра.".into());
    }

    let (sender, receiver) = oneshot::channel::<Vec<u8>>();
    window
        .with_webview(move |_| {
            PLAYERS.with(|players| {
                let mut players = players.borrow_mut();
                if let Some(player) = players.get(&id) {
                    let context = Box::into_raw(Box::new(sender)).cast();
                    unsafe {
                        if let Some(seconds) = seconds {
                            yw_video_thumbnail(player.0.as_ptr(), seconds, context, complete_frame);
                        } else {
                            yw_video_frame(player.0.as_ptr(), context, complete_frame);
                        }
                    }
                }
                if close {
                    players.remove(&id);
                }
            });
        })
        .map_err(|error| error.to_string())?;
    let timeout = if seconds.is_some() { 7 } else { 2 };
    let frame = tokio::time::timeout(std::time::Duration::from_secs(timeout), receiver)
        .await
        .ok()
        .and_then(Result::ok)
        .unwrap_or_default();
    Ok(tauri::ipc::Response::new(frame))
}

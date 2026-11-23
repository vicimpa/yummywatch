use std::{
    ffi::{c_char, c_int, c_void, CStr, CString},
    ptr::{self, NonNull},
};

#[cfg(target_os = "windows")]
use std::path::Path;
#[cfg(any(target_os = "windows", target_os = "android"))]
use std::sync::OnceLock;

// Stable subset of the libmpv 2.x client and software rendering ABIs.
macro_rules! mpv_api {
    ($($(#[$attr:meta])* fn $name:ident($($arg:ident: $ty:ty),*) $(-> $ret:ty)?;)*) => {
        pub(super) struct Api {
            $($(#[$attr])* $name: unsafe extern "C" fn($($ty),*) $(-> $ret)?,)*
            #[cfg(any(target_os = "windows", target_os = "android"))]
            _library: libloading::Library,
        }

        #[cfg(target_os = "linux")]
        #[link(name = "mpv")]
        extern "C" {
            $($(#[$attr])* fn $name($($arg: $ty),*) $(-> $ret)?;)*
        }

        #[cfg(target_os = "linux")]
        pub(super) static API: Api = Api { $($(#[$attr])* $name,)* };

        #[cfg(target_os = "windows")]
        impl Api {
            fn load(path: &Path) -> Result<Self, libloading::Error> {
                // Resolve the bundled DLL and any dependent system DLLs from trusted paths.
                use libloading::os::windows::{Library, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR, LOAD_LIBRARY_SEARCH_SYSTEM32};
                let library = unsafe {
                    Library::load_with_flags(path, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32)?
                };
                Ok(Self {
                    $($(#[$attr])* $name: unsafe { *library.get(concat!(stringify!($name), "\0").as_bytes())? },)*
                    _library: library.into(),
                })
            }
        }

        #[cfg(target_os = "android")]
        impl Api {
            fn load() -> Result<Self, libloading::Error> {
                let library = unsafe { libloading::Library::new("libmpv.so")? };
                Ok(Self {
                    $($(#[$attr])* $name: unsafe { *library.get(concat!(stringify!($name), "\0").as_bytes())? },)*
                    _library: library,
                })
            }
        }
    };
}

mpv_api! {
    fn mpv_create() -> *mut c_void;
    fn mpv_initialize(handle: *mut c_void) -> c_int;
    fn mpv_terminate_destroy(handle: *mut c_void);
    fn mpv_set_option_string(handle: *mut c_void, name: *const c_char, value: *const c_char) -> c_int;
    fn mpv_command_async(handle: *mut c_void, reply: u64, args: *const *const c_char) -> c_int;
    fn mpv_set_property_async(handle: *mut c_void, reply: u64, name: *const c_char, format: c_int, data: *mut c_void) -> c_int;
    fn mpv_get_property(handle: *mut c_void, name: *const c_char, format: c_int, data: *mut c_void) -> c_int;
    fn mpv_wait_event(handle: *mut c_void, timeout: f64) -> *const Event;
    fn mpv_error_string(error: c_int) -> *const c_char;
    #[cfg(not(target_os = "android"))]
    fn mpv_render_context_create(ctx: *mut *mut c_void, handle: *mut c_void, params: *mut RenderParam) -> c_int;
    #[cfg(not(target_os = "android"))]
    fn mpv_render_context_update(ctx: *mut c_void) -> u64;
    #[cfg(not(target_os = "android"))]
    fn mpv_render_context_render(ctx: *mut c_void, params: *mut RenderParam) -> c_int;
    #[cfg(not(target_os = "android"))]
    fn mpv_render_context_free(ctx: *mut c_void);
}

#[cfg(target_os = "windows")]
pub(super) fn windows_api(path: &Path) -> Result<&'static Api, String> {
    static API: OnceLock<Result<Api, String>> = OnceLock::new();
    API.get_or_init(|| {
        Api::load(path).map_err(|error| format!("Не удалось загрузить libmpv: {error}"))
    })
    .as_ref()
    .map_err(Clone::clone)
}

#[cfg(target_os = "android")]
pub(super) fn android_api() -> Result<&'static Api, String> {
    static API: OnceLock<Result<Api, String>> = OnceLock::new();
    API.get_or_init(|| Api::load().map_err(|error| format!("Не удалось загрузить libmpv: {error}")))
        .as_ref()
        .map_err(Clone::clone)
}

const FLAG: c_int = 3;
const INT64: c_int = 4;
const DOUBLE: c_int = 5;
const OPTION_NOT_FOUND: c_int = -5;
const EVENT_NONE: c_int = 0;
const EVENT_END_FILE: c_int = 7;
const EVENT_FILE_LOADED: c_int = 8;
const END_FILE_ERROR: c_int = 4;

#[repr(C)]
struct Event {
    id: c_int,
    error: c_int,
    reply_userdata: u64,
    data: *const c_void,
}

#[repr(C)]
struct EndFile {
    reason: c_int,
    error: c_int,
}

#[cfg(target_os = "android")]
pub(super) struct AndroidOutput {
    pub(super) surface: jni::objects::GlobalRef,
    pub(super) certificates: CString,
}

#[cfg(not(target_os = "android"))]
#[repr(C)]
struct RenderParam {
    kind: c_int,
    data: *mut c_void,
}

#[cfg(not(target_os = "android"))]
impl RenderParam {
    fn input<T>(kind: c_int, data: &T) -> Self {
        Self {
            kind,
            data: ptr::from_ref(data).cast_mut().cast(),
        }
    }

    const END: Self = Self {
        kind: 0,
        data: ptr::null_mut(),
    };
}

pub(super) struct Player {
    api: &'static Api,
    handle: NonNull<c_void>,
    #[cfg(not(target_os = "android"))]
    render: Option<NonNull<c_void>>,
    caption: Option<CString>,
    failure: Option<String>,
    ready: bool,
    #[cfg(not(target_os = "android"))]
    render_size: Option<[c_int; 2]>,
    #[cfg(target_os = "android")]
    _surface: jni::objects::GlobalRef,
}

// A session is moved between blocking workers. Its mutex serializes every
// call into this core and render context, including rendering and destruction.
unsafe impl Send for Player {}

impl Player {
    pub(super) fn open(
        api: &'static Api,
        url: &CStr,
        caption: Option<CString>,
        start: f64,
        relayed_hls: bool,
        silent: bool,
        #[cfg(target_os = "android")] output: AndroidOutput,
    ) -> Result<Self, String> {
        let handle = NonNull::new(unsafe { (api.mpv_create)() })
            .ok_or("Не удалось создать плеер libmpv.")?;
        let player = Self {
            api,
            handle,
            #[cfg(not(target_os = "android"))]
            render: None,
            caption,
            failure: None,
            ready: false,
            #[cfg(not(target_os = "android"))]
            render_size: None,
            #[cfg(target_os = "android")]
            _surface: output.surface,
        };
        let start = CString::new(start.clamp(0.0, 86400.0).to_string()).unwrap();
        for (name, value) in [
            (c"config", c"no"),
            (c"terminal", c"no"),
            (c"ytdl", c"no"),
            (c"load-scripts", c"no"),
            (c"load-unsafe-playlists", c"no"),
            (c"sub-auto", c"no"),
            (c"audio-file-auto", c"no"),
            (c"pause", c"yes"),
            (c"mute", c"yes"),
            (c"keep-open", c"yes"),
            (c"tls-verify", c"yes"),
            (c"network-timeout", c"15"),
            (c"start", start.as_c_str()),
        ] {
            player.option(name, value)?;
        }
        if let Some(referrer) = crate::providers::native_aksor_referrer(url) {
            player.option(c"referrer", &referrer)?;
        }
        #[cfg(target_os = "android")]
        {
            let surface =
                CString::new((player._surface.as_obj().as_raw() as usize).to_string()).unwrap();
            player.option(c"profile", c"fast")?;
            player.option(c"wid", &surface)?;
            player.option(c"vo", c"gpu")?;
            player.option(c"gpu-context", c"android")?;
            player.option(c"gpu-api", c"opengl")?;
            player.option(c"opengl-es", c"yes")?;
            player.option(c"hwdec", c"mediacodec,mediacodec-copy")?;
            player.option(c"tls-ca-file", &output.certificates)?;
        }
        #[cfg(not(target_os = "android"))]
        {
            player.option(c"vo", c"libmpv")?;
            player.option(c"hwdec", c"auto-copy")?;
        }
        if silent {
            player.option(c"ao", c"null")?;
        }
        if relayed_hls {
            // The relay emits opaque resource IDs without file extensions.
            player.option(
                c"demuxer-lavf-o",
                c"protocol_whitelist=[http,https,tcp,tls,crypto,data],allowed_extensions=ALL,allowed_segment_extensions=ALL,extension_picky=0",
            )?;
        } else {
            player.option(
                c"demuxer-lavf-o",
                c"protocol_whitelist=[http,https,tcp,tls,crypto,data]",
            )?;
        }
        if unsafe { (api.mpv_initialize)(handle.as_ptr()) } < 0 {
            return Err("Не удалось запустить libmpv.".into());
        }
        #[cfg(not(target_os = "android"))]
        let player = {
            let mut player = player;
            let mut context = ptr::null_mut();
            let mut params = [
                RenderParam {
                    kind: 1,
                    data: c"sw".as_ptr().cast_mut().cast(),
                },
                RenderParam::END,
            ];
            if unsafe {
                (api.mpv_render_context_create)(&mut context, handle.as_ptr(), params.as_mut_ptr())
            } < 0
            {
                return Err("Не удалось создать видеоповерхность libmpv.".into());
            }
            player.render = NonNull::new(context);
            player
        };
        if !player.command(&[c"loadfile", url]) {
            return Err("Не удалось открыть поток в libmpv.".into());
        }
        Ok(player)
    }

    fn option(&self, name: &CStr, value: &CStr) -> Result<(), String> {
        let result = unsafe {
            (self.api.mpv_set_option_string)(self.handle.as_ptr(), name.as_ptr(), value.as_ptr())
        };
        // The bundled LGPL build can omit script support entirely.
        let absent_script_option =
            result == OPTION_NOT_FOUND && (name == c"ytdl" || name == c"load-scripts");
        (result >= 0 || absent_script_option)
            .then_some(())
            .ok_or_else(|| {
                format!(
                    "Не удалось задать параметр libmpv {} ({result}).",
                    name.to_string_lossy()
                )
            })
    }

    fn command(&self, values: &[&CStr]) -> bool {
        let args: Vec<_> = values
            .iter()
            .map(|value| value.as_ptr())
            .chain([ptr::null()])
            .collect();
        unsafe { (self.api.mpv_command_async)(self.handle.as_ptr(), 0, args.as_ptr()) >= 0 }
    }

    fn get<T: Default>(&self, name: &CStr, format: c_int) -> Option<T> {
        let mut value = T::default();
        let result = unsafe {
            (self.api.mpv_get_property)(
                self.handle.as_ptr(),
                name.as_ptr(),
                format,
                ptr::from_mut(&mut value).cast(),
            )
        };
        (result >= 0).then_some(value)
    }

    fn set<T>(&self, name: &CStr, format: c_int, mut value: T) {
        unsafe {
            (self.api.mpv_set_property_async)(
                self.handle.as_ptr(),
                0,
                name.as_ptr(),
                format,
                ptr::from_mut(&mut value).cast(),
            );
        }
    }

    fn number(&self, name: &CStr) -> f64 {
        self.get::<f64>(name, DOUBLE)
            .filter(|number| number.is_finite())
            .unwrap_or_default()
    }

    fn flag(&self, name: &CStr) -> Option<bool> {
        self.get::<c_int>(name, FLAG).map(|flag| flag != 0)
    }

    fn events(&mut self) {
        loop {
            let event = unsafe { &*(self.api.mpv_wait_event)(self.handle.as_ptr(), 0.0) };
            match event.id {
                EVENT_NONE => break,
                EVENT_FILE_LOADED => {
                    self.ready = true;
                    if let Some(caption) = self.caption.take() {
                        self.command(&[c"sub-add", &caption, c"select"]);
                    }
                }
                EVENT_END_FILE if !event.data.is_null() => {
                    let end = unsafe { &*event.data.cast::<EndFile>() };
                    if end.reason == END_FILE_ERROR {
                        let message =
                            unsafe { CStr::from_ptr((self.api.mpv_error_string)(end.error)) };
                        self.failure = Some(message.to_string_lossy().into_owned());
                    }
                }
                _ => {}
            }
        }
    }

    pub(super) fn poll(&mut self, controls: super::Controls) -> super::Snapshot {
        self.events();
        for (name, value, low, high, multiplier) in [
            (c"volume", controls.volume, 0.0, 1.0, 100.0),
            (c"speed", controls.speed, 0.375, 2.5, 1.0),
        ] {
            if let Some(value) = value.filter(|v| v.is_finite()) {
                self.set(name, DOUBLE, value.clamp(low, high) * multiplier);
            }
        }
        let seek = controls
            .seconds
            .filter(|value| value.is_finite())
            .map(|value| {
                let seconds = CString::new(value.clamp(0.0, 86400.0).to_string()).unwrap();
                self.command(&[c"seek", &seconds, c"absolute+exact"])
            })
            .unwrap_or_default();
        for (name, value) in [(c"mute", controls.mute), (c"pause", controls.pause)] {
            if let Some(value) = value {
                self.set(name, FLAG, c_int::from(value));
            }
        }
        let position = self.number(c"time-pos").max(0.0);
        let frame_width = self
            .get::<i64>(c"video-out-params/dw", INT64)
            .unwrap_or_default();
        let frame_height = self
            .get::<i64>(c"video-out-params/dh", INT64)
            .unwrap_or_default();
        #[cfg(target_os = "android")]
        let has_frame = frame_width > 0 && frame_height > 0;
        #[cfg(not(target_os = "android"))]
        let has_frame = self.render_size.is_some();
        super::Snapshot {
            position,
            duration: self.number(c"duration"),
            buffered: self.number(c"demuxer-cache-time").max(position),
            ready: self.ready && has_frame,
            frame_width,
            frame_height,
            seeking: seek || self.flag(c"seeking").unwrap_or_default(),
            buffering: self.flag(c"paused-for-cache").unwrap_or_default(),
            ended: !seek && self.flag(c"eof-reached").unwrap_or_default(),
            failure: self.failure.is_some(),
            failure_message: self.failure.clone(),
            paused: controls.pause.or_else(|| self.flag(c"pause")),
        }
    }

    #[cfg(not(target_os = "android"))]
    pub(super) fn pixels(&mut self, size: [c_int; 2]) -> Vec<u8> {
        let Some(context) = self.render else {
            return Vec::new();
        };
        let update = unsafe { (self.api.mpv_render_context_update)(context.as_ptr()) } & 1 != 0;
        if !update && !self.render_size.is_some_and(|last| last != size) {
            return Vec::new();
        }

        let stride = size[0] as usize * 4;
        let length = stride * size[1] as usize;
        let mut pixels = vec![0u8; length + 63];
        let offset = pixels.as_ptr().align_offset(64);
        let mut block_for_target_time: c_int = 0;
        let mut params = [
            RenderParam::input(17, &size),
            RenderParam {
                kind: 18,
                data: c"rgb0".as_ptr().cast_mut().cast(),
            },
            RenderParam::input(19, &stride),
            RenderParam {
                kind: 20,
                data: pixels[offset..].as_mut_ptr().cast(),
            },
            RenderParam {
                kind: 12,
                data: ptr::from_mut(&mut block_for_target_time).cast(),
            },
            RenderParam::END,
        ];
        if unsafe { (self.api.mpv_render_context_render)(context.as_ptr(), params.as_mut_ptr()) }
            < 0
        {
            return Vec::new();
        }
        for alpha in pixels[offset + 3..offset + length].iter_mut().step_by(4) {
            *alpha = 255;
        }
        pixels.copy_within(offset..offset + length, 0);
        pixels.truncate(length);
        self.render_size = Some(size);
        pixels
    }
}

impl Drop for Player {
    fn drop(&mut self) {
        unsafe {
            #[cfg(not(target_os = "android"))]
            if let Some(context) = self.render {
                (self.api.mpv_render_context_free)(context.as_ptr());
            }
            (self.api.mpv_terminate_destroy)(self.handle.as_ptr());
        }
    }
}

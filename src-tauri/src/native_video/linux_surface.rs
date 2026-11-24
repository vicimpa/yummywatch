use super::{mpv, Geometry};
use gtk::{glib, prelude::*};
use std::{
    cell::RefCell,
    collections::HashMap,
    ffi::{c_char, c_void},
    ptr,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
};

type GetProcAddress = unsafe extern "C" fn(*const c_char) -> *mut c_void;
type GetCurrentContext = unsafe extern "C" fn() -> *mut c_void;

struct GlLibrary {
    _library: libloading::Library,
    address: GetProcAddress,
    current: GetCurrentContext,
}

impl GlLibrary {
    fn load(library: &str, address: &[u8], current: &[u8]) -> Option<Self> {
        unsafe {
            let library = libloading::Library::new(library).ok()?;
            Some(Self {
                address: *library.get(address).ok()?,
                current: *library.get(current).ok()?,
                _library: library,
            })
        }
    }
}

unsafe extern "C" fn get_proc_address(_: *mut c_void, name: *const c_char) -> *mut c_void {
    static LIBRARIES: OnceLock<[Option<GlLibrary>; 2]> = OnceLock::new();
    let libraries = LIBRARIES.get_or_init(|| {
        [
            GlLibrary::load("libEGL.so.1", b"eglGetProcAddress", b"eglGetCurrentContext"),
            ["libGLX.so.0", "libGL.so.1"]
                .into_iter()
                .find_map(|library| {
                    GlLibrary::load(library, b"glXGetProcAddressARB", b"glXGetCurrentContext")
                }),
        ]
    });
    libraries
        .iter()
        .flatten()
        .find(|library| unsafe { !(library.current)().is_null() })
        .map_or(ptr::null_mut(), |library| unsafe {
            (library.address)(name)
        })
}

thread_local! {
    static SURFACES: RefCell<HashMap<u32, gtk::GLArea>> = RefCell::new(HashMap::new());
}

fn video_container(webview: &gtk::Widget) -> Result<gtk::Overlay, String> {
    let parent = webview.parent().ok_or("У WebView отсутствует контейнер.")?;
    if let Some(overlay) = parent.downcast_ref::<gtk::Overlay>() {
        return Ok(overlay.clone());
    }
    let parent = parent
        .downcast::<gtk::Box>()
        .map_err(|_| "Не удалось встроить видеоповерхность в WebView.")?;
    let overlay = gtk::Overlay::new();
    let background = gtk::DrawingArea::new();
    background.connect_draw(|_, context| {
        context.set_source_rgb(0.133, 0.133, 0.133);
        let _ = context.paint();
        glib::Propagation::Stop
    });
    overlay.add(&background);
    parent.remove(webview);
    overlay.add_overlay(webview);
    parent.pack_start(&overlay, true, true, 0);
    overlay.show_all();
    Ok(overlay)
}

pub(super) fn open(
    id: u32,
    webview: &impl IsA<gtk::Widget>,
    player: &Arc<Mutex<Option<mpv::Player>>>,
    initialize: impl FnOnce(mpv::OpenGlInit) -> Result<mpv::Player, String>,
) -> Result<(), String> {
    let overlay = video_container(webview.as_ref())?;
    let area = gtk::GLArea::new();
    area.set_required_version(3, 2);
    area.set_has_alpha(true);
    area.set_auto_render(false);
    area.set_direction(gtk::TextDirection::Ltr);
    area.set_halign(gtk::Align::Start);
    area.set_valign(gtk::Align::Start);
    area.set_size_request(1, 1);
    overlay.add_overlay(&area);
    overlay.reorder_overlay(&area, 0);
    overlay.set_overlay_pass_through(&area, true);
    area.show();
    area.make_current();

    let init = mpv::OpenGlInit {
        get_proc_address,
        context: ptr::null_mut(),
    };
    let pending = Arc::new(AtomicBool::new(true));
    let result = (|| {
        if let Some(error) = area.error() {
            return Err(format!("Не удалось создать контекст OpenGL: {error}"));
        }
        let get_integer = unsafe { get_proc_address(ptr::null_mut(), c"glGetIntegerv".as_ptr()) };
        if get_integer.is_null() {
            return Err("Не удалось найти функции OpenGL для видеоплеера.".into());
        }
        let get_integer: unsafe extern "C" fn(u32, *mut i32) =
            unsafe { std::mem::transmute(get_integer) };
        let mut initialized = initialize(init)?;
        initialized.notify_render(pending.clone());
        *player.lock().unwrap() = Some(initialized);
        Ok(get_integer)
    })();
    let get_integer = match result {
        Ok(function) => function,
        Err(error) => {
            overlay.remove(&area);
            return Err(error);
        }
    };

    let state = Arc::downgrade(player);
    let render_pending = pending.clone();
    area.connect_render(move |area, _| {
        if let Some(state) = state.upgrade() {
            if let Ok(mut state) = state.try_lock() {
                if let Some(player) = state.as_mut() {
                    const GL_DRAW_FRAMEBUFFER_BINDING: u32 = 0x8CA6;
                    let mut framebuffer = 0;
                    unsafe { get_integer(GL_DRAW_FRAMEBUFFER_BINDING, &mut framebuffer) };
                    let scale = area.scale_factor();
                    player.render_gl(
                        framebuffer,
                        [
                            area.allocated_width() * scale,
                            area.allocated_height() * scale,
                        ],
                    );
                }
            } else {
                render_pending.store(true, Ordering::Release);
            }
        }
        glib::Propagation::Stop
    });
    let state = Arc::downgrade(player);
    area.connect_unrealize(move |area| {
        if let Some(state) = state.upgrade() {
            area.make_current();
            if let Some(player) = state.lock().unwrap().as_mut() {
                player.free_renderer();
            }
        }
    });
    area.connect_size_allocate(|area, _| area.queue_render());
    area.add_tick_callback(move |area, _| {
        if pending.swap(false, Ordering::AcqRel) {
            area.queue_render();
        }
        glib::ControlFlow::Continue
    });
    SURFACES.with_borrow_mut(|surfaces| surfaces.insert(id, area));
    Ok(())
}

pub(super) fn layout(id: u32, visible: bool, geometry: Geometry) {
    SURFACES.with_borrow(|surfaces| {
        let Some(area) = surfaces.get(&id) else {
            return;
        };
        let Some(parent) = area.parent() else {
            return;
        };
        let [x, y, width, height] = if visible {
            geometry.bounds(parent.allocated_width(), parent.allocated_height())
        } else {
            [0, 0, 1, 1]
        };
        if area.margin_start() != x {
            area.set_margin_start(x);
        }
        if area.margin_top() != y {
            area.set_margin_top(y);
        }
        if area.width_request() != width || area.height_request() != height {
            area.set_size_request(width, height);
        }
    });
}

pub(super) fn close(id: u32) {
    if let Some(area) = SURFACES.with_borrow_mut(|surfaces| surfaces.remove(&id)) {
        if let Some(parent) = area.parent().and_downcast::<gtk::Overlay>() {
            parent.remove(&area);
        }
    }
}

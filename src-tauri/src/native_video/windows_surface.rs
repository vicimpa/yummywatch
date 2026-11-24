use super::Geometry;
use std::{cell::RefCell, collections::HashMap, ffi::OsStr, mem, os::windows::ffi::OsStrExt, ptr};
use windows_sys::Win32::{
    Foundation::{HWND, RECT},
    System::LibraryLoader::GetModuleHandleW,
    UI::WindowsAndMessaging::{
        CreateWindowExW, DestroyWindow, GetClientRect, SetWindowPos, HWND_BOTTOM, SWP_HIDEWINDOW,
        SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW, WS_CHILD, WS_CLIPCHILDREN,
        WS_EX_NOACTIVATE,
    },
};

struct Surface {
    host: HWND,
    parent: HWND,
    placement: Option<([i32; 4], bool)>,
}

thread_local! {
    static SURFACES: RefCell<HashMap<u32, Surface>> = RefCell::new(HashMap::new());
}

pub(super) fn open(id: u32, parent: usize) -> Result<usize, String> {
    let window_class: Vec<u16> = OsStr::new("STATIC").encode_wide().chain([0]).collect();
    let parent = parent as HWND;
    let host = unsafe {
        CreateWindowExW(
            WS_EX_NOACTIVATE,
            window_class.as_ptr(),
            ptr::null(),
            WS_CHILD | WS_CLIPCHILDREN,
            0,
            0,
            1,
            1,
            parent,
            ptr::null_mut(),
            GetModuleHandleW(ptr::null()),
            ptr::null(),
        )
    };
    if host.is_null() {
        return Err(format!(
            "Не удалось создать окно видеоплеера: {}",
            std::io::Error::last_os_error()
        ));
    }
    SURFACES.with_borrow_mut(|surfaces| {
        surfaces.insert(
            id,
            Surface {
                host,
                parent,
                placement: None,
            },
        );
    });
    Ok(host as usize)
}

pub(super) fn layout(id: u32, visible: bool, geometry: Geometry) {
    SURFACES.with_borrow_mut(|surfaces| {
        let Some(surface) = surfaces.get_mut(&id) else {
            return;
        };
        let mut client: RECT = unsafe { mem::zeroed() };
        if unsafe { GetClientRect(surface.parent, &mut client) } == 0 {
            return;
        }
        let bounds = geometry.bounds(client.right, client.bottom);
        let placement = (bounds, visible);
        if surface.placement == Some(placement) {
            return;
        }
        let [x, y, width, height] = bounds;
        // WebView2 stays above the video and continues to receive pointer events.
        let flags = if visible {
            SWP_SHOWWINDOW
        } else {
            SWP_HIDEWINDOW | SWP_NOMOVE | SWP_NOSIZE
        };
        if unsafe {
            SetWindowPos(
                surface.host,
                HWND_BOTTOM,
                x,
                y,
                width,
                height,
                flags | SWP_NOACTIVATE,
            )
        } != 0
        {
            surface.placement = Some(placement);
        }
    });
}

pub(super) fn close(id: u32) {
    if let Some(surface) = SURFACES.with_borrow_mut(|surfaces| surfaces.remove(&id)) {
        unsafe { DestroyWindow(surface.host) };
    }
}

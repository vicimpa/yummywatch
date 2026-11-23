use crate::backend::Backend;
use std::{
    ffi::{c_char, c_int, c_void, CStr, CString},
    ptr, slice,
    sync::{mpsc, OnceLock},
    time::Duration,
};
use tauri::http::{header, Request, Response, StatusCode};
use url::Url;

const MEDIA_ROOT: &str = "yumiwatch://media";
const CHUNK_SIZE: i64 = 8 * 1024 * 1024;
static BACKEND: OnceLock<Backend> = OnceLock::new();

pub(super) fn init(backend: &Backend) {
    BACKEND.get_or_init(|| backend.clone());
}

pub(super) fn url(raw: &str, extension: &str) -> Result<CString, String> {
    let url = Url::parse(raw).map_err(|_| "Некорректный адрес видео.")?;
    let host = url.host_str().unwrap_or_default();
    if !url.username().is_empty() || url.password().is_some() || url.port().is_some() {
        return Err("Некорректный адрес видео.".into());
    }
    let value = match (url.scheme(), host) {
        ("yumiwatch-media", "localhost") | ("http" | "https", "yumiwatch-media.localhost") => {
            let saved = crate::downloads::route(url.path()).is_some();
            if (!saved && !resource_path(url.path()))
                || url.query().is_some()
                || url.fragment().is_some()
            {
                return Err("Некорректный ресурс видеопотока.".into());
            }
            if saved {
                format!("{MEDIA_ROOT}{}", url.path())
            } else {
                format!("{MEDIA_ROOT}{}.{extension}", url.path())
            }
        }
        ("https", host) if !host.is_empty() => url.into(),
        _ => return Err("Некорректный адрес видео.".into()),
    };
    CString::new(value).map_err(|_| "Некорректный адрес видео.".into())
}

fn resource_path(path: &str) -> bool {
    let mut parts = path.strip_prefix('/').unwrap_or("").split('/');
    matches!(parts.next(), Some("media" | "alloha"))
        && (0..2).all(|_| {
            parts.next().is_some_and(|part| {
                part.len() == 32
                    && part
                        .bytes()
                        .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
            })
        })
        && parts.next().is_none()
}

struct Chunk {
    start: i64,
    length: i64,
    data: Vec<u8>,
}

impl Chunk {
    fn from_response(position: i64, response: Response<Vec<u8>>) -> Option<Self> {
        let (parts, data) = response.into_parts();
        let size = i64::try_from(data.len()).ok()?;
        let (start, length) = match parts.status {
            StatusCode::OK => (0, size),
            StatusCode::PARTIAL_CONTENT => {
                let (range, length) = parts
                    .headers
                    .get(header::CONTENT_RANGE)?
                    .to_str()
                    .ok()?
                    .strip_prefix("bytes ")?
                    .split_once('/')?;
                let (start, end) = range.split_once('-')?;
                let start: i64 = start.parse().ok()?;
                let end: i64 = end.parse().ok()?;
                let length: i64 = length.parse().ok()?;
                if start != position
                    || size == 0
                    || end >= length
                    || start.checked_add(size - 1)? != end
                {
                    return None;
                }
                (start, length)
            }
            _ => return None,
        };
        Some(Self {
            start,
            length,
            data,
        })
    }

    fn remaining(&self, position: i64) -> Option<&[u8]> {
        let offset = usize::try_from(position - self.start).ok()?;
        (offset < self.data.len()).then(|| &self.data[offset..])
    }
}

struct Stream {
    path: String,
    manifest: bool,
    position: i64,
    chunk: Option<Chunk>,
}

type InterruptFn = Option<unsafe extern "C" fn(*mut c_void) -> c_int>;

#[derive(Clone, Copy)]
struct Interrupt {
    callback: InterruptFn,
    context: *mut c_void,
}

impl Interrupt {
    fn cancelled(self) -> bool {
        // The context belongs to the FFmpeg callback and is only used on its calling thread.
        self.callback
            .is_some_and(|callback| unsafe { callback(self.context) != 0 })
    }
}

impl Stream {
    fn from_url(raw: &str) -> Option<Self> {
        let path = raw.strip_prefix(MEDIA_ROOT)?;
        if let Some((_, name)) = crate::downloads::route(path) {
            return Some(Self {
                path: path.into(),
                manifest: name.ends_with(".m3u8") || name.ends_with(".mpd"),
                position: 0,
                chunk: None,
            });
        }
        let (path, extension) = match path.split_once('.') {
            Some((path, extension @ ("m3u8" | "mp4" | "mpd" | "vtt"))) => (path, extension),
            None => (path, ""),
            _ => return None,
        };
        resource_path(path).then(|| Self {
            path: path.into(),
            manifest: matches!(extension, "m3u8" | "mpd"),
            position: 0,
            chunk: None,
        })
    }

    fn fetch(&mut self, position: i64, interrupt: Interrupt) -> Option<()> {
        if interrupt.cancelled() {
            return None;
        }
        let mut request = Request::get(self.path.as_str());
        if !self.manifest {
            let end = position.saturating_add(CHUNK_SIZE - 1);
            request = request.header(header::RANGE, format!("bytes={position}-{end}"));
        }
        let request = request.body(Vec::new()).ok()?;
        let backend = BACKEND.get()?;
        let (sender, receiver) = mpsc::sync_channel(1);
        let transfer = tauri::async_runtime::spawn(async move {
            let _ = sender.send(backend.media(request).await);
        });
        // Waiting here blocks the decoder, while the existing async Rust backend handles I/O.
        let response = loop {
            match receiver.recv_timeout(Duration::from_millis(50)) {
                Ok(response) => break response,
                Err(mpsc::RecvTimeoutError::Timeout) if !interrupt.cancelled() => continue,
                Err(_) => {
                    transfer.abort();
                    return None;
                }
            }
        };
        let chunk = Chunk::from_response(position, response)?;
        if self
            .chunk
            .as_ref()
            .is_some_and(|prev| prev.length != chunk.length)
        {
            return None;
        }
        self.chunk = Some(chunk);
        Some(())
    }

    fn read(&mut self, buffer: &mut [u8], interrupt: Interrupt) -> Option<c_int> {
        if self.chunk.as_ref().is_none_or(|chunk| {
            self.position < chunk.length && chunk.remaining(self.position).is_none()
        }) {
            self.fetch(self.position, interrupt)?;
        }
        let chunk = self.chunk.as_ref()?;
        if self.position >= chunk.length {
            return Some(0);
        }
        let data = chunk.remaining(self.position)?;
        let count = data.len().min(buffer.len());
        buffer[..count].copy_from_slice(&data[..count]);
        self.position += count as i64;
        Some(count as c_int)
    }

    fn seek(&mut self, offset: i64, whence: c_int, interrupt: Interrupt) -> Option<i64> {
        const AVSEEK_SIZE: c_int = 0x10000;
        let base = match whence {
            0 => 0,             // SEEK_SET
            1 => self.position, // SEEK_CUR
            2 | AVSEEK_SIZE => {
                if self.chunk.is_none() {
                    self.fetch(0, interrupt)?;
                }
                let length = self.chunk.as_ref()?.length;
                if whence == AVSEEK_SIZE {
                    return Some(length);
                }
                length
            }
            _ => return None,
        };
        let next = base.checked_add(offset)?;
        if next < 0 {
            return None;
        }
        self.position = next;
        Some(next)
    }
}

#[repr(C)]
pub(super) struct MediaIO {
    open: unsafe extern "C" fn(*const c_char) -> *mut c_void,
    read: unsafe extern "C" fn(*mut c_void, *mut u8, c_int, InterruptFn, *mut c_void) -> c_int,
    seek: unsafe extern "C" fn(*mut c_void, i64, c_int, InterruptFn, *mut c_void) -> i64,
    close: unsafe extern "C" fn(*mut c_void),
}

pub(super) static MEDIA_IO: MediaIO = MediaIO {
    open,
    read,
    seek,
    close,
};

// FFmpeg owns each handle from open to close and serializes its read and seek calls.
unsafe extern "C" fn open(url: *const c_char) -> *mut c_void {
    CStr::from_ptr(url)
        .to_str()
        .ok()
        .and_then(Stream::from_url)
        .map_or(ptr::null_mut(), |stream| {
            Box::into_raw(Box::new(stream)).cast()
        })
}

unsafe extern "C" fn read(
    stream: *mut c_void,
    buffer: *mut u8,
    size: c_int,
    callback: InterruptFn,
    context: *mut c_void,
) -> c_int {
    if size <= 0 {
        return 0;
    }
    let stream = &mut *stream.cast::<Stream>();
    let buffer = slice::from_raw_parts_mut(buffer, size as usize);
    stream
        .read(buffer, Interrupt { callback, context })
        .unwrap_or(-1)
}

unsafe extern "C" fn seek(
    stream: *mut c_void,
    offset: i64,
    whence: c_int,
    callback: InterruptFn,
    context: *mut c_void,
) -> i64 {
    (&mut *stream.cast::<Stream>())
        .seek(offset, whence, Interrupt { callback, context })
        .unwrap_or(-1)
}

unsafe extern "C" fn close(stream: *mut c_void) {
    drop(Box::from_raw(stream.cast::<Stream>()));
}

#[cfg(test)]
mod tests {
    use super::*;

    const RESOURCE: &str =
        "/media/0123456789abcdef0123456789abcdef/abcdef0123456789abcdef0123456789";
    const NO_INTERRUPT: Interrupt = Interrupt {
        callback: None,
        context: ptr::null_mut(),
    };

    #[test]
    fn accepts_only_registered_resource_paths_in_the_internal_protocol() {
        for origin in [
            "yumiwatch-media://localhost",
            "https://yumiwatch-media.localhost",
        ] {
            let native_url = url(&format!("{origin}{RESOURCE}"), "m3u8").unwrap();
            let stream = Stream::from_url(native_url.to_str().unwrap()).unwrap();
            assert_eq!(stream.path, RESOURCE);
            assert!(stream.manifest);
        }
        for suffix in ["?query", ".ts", "/extra"] {
            assert!(Stream::from_url(&format!("{MEDIA_ROOT}{RESOURCE}{suffix}")).is_none());
        }
        assert!(
            !Stream::from_url(&format!("{MEDIA_ROOT}{RESOURCE}"))
                .unwrap()
                .manifest
        );
        assert!(Stream::from_url("yumiwatch://media/https://example.com/stream").is_none());
        let direct = "https://example.com/video.m3u8?quality=720";
        assert_eq!(url(direct, "m3u8").unwrap().to_str().unwrap(), direct);
    }

    #[test]
    fn reads_and_seeks_in_a_partial_response_using_absolute_offsets() {
        let response = |range| {
            Response::builder()
                .status(StatusCode::PARTIAL_CONTENT)
                .header(header::CONTENT_RANGE, range)
                .body(vec![11, 22, 33])
                .unwrap()
        };
        for invalid in ["bytes 4-6/8", "bytes 5-9/10", "bytes 5-7/7", "bytes 5-7/*"] {
            assert!(Chunk::from_response(5, response(invalid)).is_none());
        }
        let mut stream = Stream::from_url(&format!("{MEDIA_ROOT}{RESOURCE}.mp4")).unwrap();
        stream.chunk = Chunk::from_response(5, response("bytes 5-7/8"));
        assert_eq!(stream.seek(0, 0x10000, NO_INTERRUPT), Some(8));
        assert_eq!(stream.seek(6, 0, NO_INTERRUPT), Some(6));
        let mut buffer = [0; 3];
        assert_eq!(stream.read(&mut buffer, NO_INTERRUPT), Some(2));
        assert_eq!(buffer, [22, 33, 0]);
        assert_eq!(stream.read(&mut buffer, NO_INTERRUPT), Some(0));
        assert_eq!(stream.seek(-3, 2, NO_INTERRUPT), Some(5));
        assert_eq!(stream.read(&mut buffer, NO_INTERRUPT), Some(3));
        assert_eq!(buffer, [11, 22, 33]);
    }
}

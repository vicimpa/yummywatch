use crate::{alloha::token, backend::Backend};
use futures_util::stream;
use http_body_util::{combinators::UnsyncBoxBody, BodyExt, Full, StreamBody};
use hyper::{
    body::{Bytes, Frame, Incoming},
    server::conn::http1,
    service::service_fn,
};
use hyper_util::rt::{TokioIo, TokioTimer};
use std::{convert::Infallible, io, sync::Arc, time::Duration};
use tauri::http::{header, HeaderMap, Method, Request, Response, StatusCode};
use tokio::{
    net::TcpListener,
    sync::{OnceCell, Semaphore},
};
use url::Url;

static RELAY: OnceCell<Relay> = OnceCell::const_new();
type Body = UnsyncBoxBody<Bytes, io::Error>;

struct Relay {
    key: String,
    address: std::net::SocketAddr,
}

fn resource_path(path: &str) -> Option<&str> {
    if download_resource(path) {
        return Some(path);
    }
    let path = path.split_once('.').map_or(path, |(path, _)| path);
    let (source, ids) = path.strip_prefix('/')?.split_once('/')?;
    let (session, resource) = ids.split_once('/')?;
    let hex = |id: &str| {
        id.len() == 32
            && id
                .bytes()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
    };
    (matches!(source, "alloha" | "media") && hex(session) && hex(resource)).then_some(path)
}

fn download_resource(path: &str) -> bool {
    #[cfg(desktop)]
    return crate::downloads::route(path).is_some();
    #[cfg(not(desktop))]
    {
        let _ = path;
        false
    }
}

pub(super) async fn media_url(
    backend: &Backend,
    raw: &str,
    extension: &str,
) -> Result<(String, bool), String> {
    let url = Url::parse(raw).map_err(|_| "Некорректный адрес видео.")?;
    if !url.username().is_empty() || url.password().is_some() || url.port().is_some() {
        return Err("Некорректный адрес видео.".into());
    }
    let host = url.host_str().unwrap_or_default();
    let relayed = matches!(
        (url.scheme(), host),
        ("yumiwatch-media", "localhost") | ("http" | "https", "yumiwatch-media.localhost")
    );
    if relayed {
        let path = resource_path(url.path())
            .filter(|path| *path == url.path() && url.query().is_none() && url.fragment().is_none())
            .ok_or("Некорректный ресурс видеопотока.")?;
        let relay = RELAY
            .get_or_try_init(|| async { Relay::start(backend.clone()).await })
            .await
            .map_err(|error| format!("Не удалось подключить транспорт libmpv: {error}"))?;
        Ok((
            if download_resource(path) {
                format!("http://{}/{}{path}", relay.address, relay.key)
            } else {
                format!("http://{}/{}{path}.{extension}", relay.address, relay.key)
            },
            true,
        ))
    } else if url.scheme() == "https" && !host.is_empty() {
        Ok((url.into(), false))
    } else {
        Err("Некорректный адрес видео.".into())
    }
}

impl Relay {
    async fn start(backend: Backend) -> io::Result<Self> {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await?;
        let relay = Relay {
            key: token(),
            address: listener.local_addr()?,
        };
        let base = Arc::new(format!("/{}", relay.key));
        tauri::async_runtime::spawn(async move {
            let capacity = Arc::new(Semaphore::new(16));
            while let Ok((socket, _)) = listener.accept().await {
                let Ok(permit) = capacity.clone().try_acquire_owned() else {
                    continue;
                };
                let backend = backend.clone();
                let base = base.clone();
                tauri::async_runtime::spawn(async move {
                    let _permit = permit;
                    let service =
                        service_fn(move |request| serve(backend.clone(), base.clone(), request));
                    let _ = http1::Builder::new()
                        .timer(TokioTimer::new())
                        .header_read_timeout(Duration::from_secs(5))
                        .keep_alive(false)
                        .serve_connection(TokioIo::new(socket), service)
                        .await;
                });
            }
        });
        Ok(relay)
    }
}

fn full(bytes: Vec<u8>) -> Body {
    Full::new(Bytes::from(bytes))
        .map_err(|never| match never {})
        .boxed_unsync()
}

async fn serve(
    backend: Backend,
    base: Arc<String>,
    request: Request<Incoming>,
) -> Result<Response<Body>, Infallible> {
    let path = request
        .uri()
        .path()
        .strip_prefix(base.as_str())
        .and_then(resource_path);
    let Some(path) = path.filter(|_| {
        request.uri().query().is_none()
            && matches!(*request.method(), Method::GET | Method::HEAD)
            && !request.headers().contains_key(header::ORIGIN)
    }) else {
        return Ok(Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(full(Vec::new()))
            .unwrap());
    };
    let range = request.headers().get(header::RANGE).cloned();
    let mut upstream = Request::builder()
        .method(request.method().clone())
        .uri(path);
    if let Some(range) = &range {
        upstream = upstream.header(header::RANGE, range);
    }
    let (mut parts, bytes) = backend
        .media(upstream.body(Vec::new()).unwrap())
        .await
        .into_parts();
    parts.headers.remove(header::ACCESS_CONTROL_ALLOW_ORIGIN);

    // The native CVH backend limits each read to 8 MiB. Present a continuous,
    // seekable response to FFmpeg while fetching the rest in bounded chunks.
    let body = if request.method() == Method::GET
        && (path.starts_with("/media/") || path.starts_with("/downloads/"))
        && parts.status == StatusCode::PARTIAL_CONTENT
    {
        let span = Span::from_headers(&parts.headers, bytes.len());
        if let Some(span) = span {
            let wanted = range.as_ref().and_then(|value| value.to_str().ok());
            let end = wanted
                .and_then(|value| value.rsplit_once('-'))
                .filter(|(start, _)| *start != "bytes=")
                .and_then(|(_, end)| end.parse::<u64>().ok())
                .unwrap_or(span.total - 1)
                .min(span.total - 1);
            if end > span.end {
                let size = end - span.start + 1;
                parts
                    .headers
                    .insert(header::CONTENT_LENGTH, size.to_string().parse().unwrap());
                if range.is_none() && span.start == 0 {
                    parts.status = StatusCode::OK;
                    parts.headers.remove(header::CONTENT_RANGE);
                } else {
                    let content_range = format!("bytes {}-{end}/{}", span.start, span.total);
                    parts
                        .headers
                        .insert(header::CONTENT_RANGE, content_range.parse().unwrap());
                }
                stream_range(
                    backend,
                    path.to_owned(),
                    span.end + 1,
                    end,
                    span.total,
                    bytes,
                )
            } else {
                full(bytes)
            }
        } else {
            full(bytes)
        }
    } else {
        full(bytes)
    };
    Ok(Response::from_parts(parts, body))
}

struct Span {
    start: u64,
    end: u64,
    total: u64,
}

impl Span {
    fn from_headers(headers: &HeaderMap, length: usize) -> Option<Self> {
        let raw = headers
            .get(header::CONTENT_RANGE)?
            .to_str()
            .ok()?
            .strip_prefix("bytes ")?;
        let (range, total) = raw.split_once('/')?;
        let (start, end) = range.split_once('-')?;
        let span = Self {
            start: start.parse().ok()?,
            end: end.parse().ok()?,
            total: total.parse().ok()?,
        };
        (span.start <= span.end
            && span.end < span.total
            && span.end - span.start + 1 == length as u64)
            .then_some(span)
    }
}

fn stream_range(
    backend: Backend,
    path: String,
    start: u64,
    end: u64,
    total: u64,
    first: Vec<u8>,
) -> Body {
    let chunks = stream::unfold(
        Some((backend, path, start, Some(first))),
        move |state| async move {
            let (backend, path, position, first) = state?;
            if let Some(bytes) = first {
                return Some((
                    Ok(Frame::data(Bytes::from(bytes))),
                    Some((backend, path, position, None)),
                ));
            }
            if position > end {
                return None;
            }
            let request = Request::get(&path)
                .header(header::RANGE, format!("bytes={position}-{end}"))
                .body(Vec::new())
                .unwrap();
            let (parts, bytes) = backend.media(request).await.into_parts();
            let span = Span::from_headers(&parts.headers, bytes.len()).filter(|span| {
                parts.status == StatusCode::PARTIAL_CONTENT
                    && span.start == position
                    && span.end <= end
                    && span.total == total
            });
            match span {
                Some(span) => Some((
                    Ok(Frame::data(Bytes::from(bytes))),
                    Some((backend, path, span.end + 1, None)),
                )),
                None => Some((Err(io::Error::other("Incomplete media range")), None)),
            }
        },
    );
    StreamBody::new(chunks).boxed_unsync()
}

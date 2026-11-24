mod alloha;
mod backend;
mod discord;
#[cfg(any(desktop, target_os = "android"))]
mod download_dash;
#[cfg(desktop)]
mod download_hls;
#[cfg(desktop)]
mod downloads;
mod images;
mod interface_scale;
mod keep_awake;
#[cfg(target_os = "macos")]
mod macos_window;
mod media;
#[cfg(target_os = "macos")]
mod native_video;
#[cfg(target_os = "macos")]
pub use native_video::check_bundled_library;
#[cfg(any(target_os = "linux", target_os = "windows", target_os = "android"))]
#[path = "native_video/portable.rs"]
mod native_video;
mod providers;
mod server_status;
mod session;
#[cfg(desktop)]
mod shutdown;
mod skips;
mod updates;

use serde::{Deserialize, Serialize};
use std::{collections::HashMap, time::Duration};
use tauri::Manager;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopInfo {
    platform: &'static str,
    #[cfg(target_os = "android")]
    native_mpv: bool,
}

#[tauri::command]
fn desktop_info() -> DesktopInfo {
    DesktopInfo {
        platform: std::env::consts::OS,
        #[cfg(target_os = "android")]
        native_mpv: native_video::available(),
    }
}

fn cursor_visibility(window: &tauri::Window, visible: bool) -> Result<(), String> {
    #[cfg(mobile)]
    {
        let _ = (window, visible);
        return Ok(());
    }
    #[cfg(desktop)]
    {
        // A delayed WebView request must not hide the cursor after focus moved away.
        let visible = visible || !window.is_focused().unwrap_or(false);
        #[cfg(target_os = "macos")]
        return window
            .run_on_main_thread(move || {
                // AppKit restores this automatically on real mouse movement, including
                // movement over native window chrome that never reaches the WebView.
                objc2_app_kit::NSCursor::setHiddenUntilMouseMoves(!visible);
            })
            .map_err(|error| error.to_string());
        #[cfg(not(target_os = "macos"))]
        window
            .set_cursor_visible(visible)
            .map_err(|error| error.to_string())
    }
}

#[tauri::command]
fn set_window_cursor_visible(window: tauri::Window, visible: bool) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Неизвестное окно.".into());
    }
    cursor_visibility(&window, visible)
}

#[tauri::command]
async fn load_account_session(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, session::SessionVault>,
) -> Result<Option<session::SavedSession>, String> {
    if window.label() != "main" {
        return Err("Неизвестное окно.".into());
    }
    let vault = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || vault.load())
        .await
        .map_err(|_| "Не удалось прочитать сохранённый вход.".to_string())?
}

#[tauri::command]
async fn save_account_session(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, session::SessionVault>,
    session: Option<session::SavedSession>,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Неизвестное окно.".into());
    }
    let vault = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || vault.save(session))
        .await
        .map_err(|_| "Не удалось сохранить вход.".to_string())?
}

#[tauri::command]
fn set_window_controls_visible(window: tauri::WebviewWindow, visible: bool) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Неизвестное окно.".into());
    }
    #[cfg(target_os = "macos")]
    {
        let target = window.clone();
        window
            .run_on_main_thread(move || {
                use objc2_app_kit::{NSWindow, NSWindowButton};
                let Ok(pointer) = target.ns_window() else {
                    return;
                };
                if pointer.is_null() {
                    return;
                }
                // Tauri owns this NSWindow; acquire and use it only on the main thread.
                let native = unsafe { &*pointer.cast::<NSWindow>() };
                for kind in [
                    NSWindowButton::CloseButton,
                    NSWindowButton::MiniaturizeButton,
                    NSWindowButton::ZoomButton,
                ] {
                    if let Some(button) = native.standardWindowButton(kind) {
                        button.setHidden(!visible);
                    }
                }
            })
            .map_err(|error| error.to_string())?;
    }
    #[cfg(not(target_os = "macos"))]
    let _ = visible;
    Ok(())
}

#[tauri::command]
async fn fetch_image(
    state: tauri::State<'_, backend::Backend>,
    url: String,
) -> Result<images::ImageResponse, String> {
    images::fetch(&state.client, &url).await
}

#[tauri::command]
async fn save_poster(
    app: tauri::AppHandle,
    state: tauri::State<'_, backend::Backend>,
    url: String,
    anime_id: u64,
) -> Result<String, String> {
    #[cfg(desktop)]
    {
        let image = images::fetch(&state.client, &url).await?;
        let directory = app
            .path()
            .download_dir()
            .map_err(|_| "Не найдена папка «Загрузки».".to_string())?;
        tauri::async_runtime::spawn_blocking(move || {
            images::save_poster(&directory, anime_id, image)
        })
        .await
        .map_err(|_| "Не удалось сохранить постер.".to_string())?
    }
    #[cfg(mobile)]
    {
        let _ = (app, state, url, anime_id);
        Err("Скачивание постера доступно в настольной версии.".into())
    }
}

#[tauri::command]
fn proxy_settings(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, backend::Backend>,
    enabled: Option<bool>,
) -> Result<bool, String> {
    if window.label() != "main" {
        return Err("Неизвестное окно.".into());
    }
    state.proxy_settings(enabled)
}

#[tauri::command]
fn proxy_pool_report(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, backend::Backend>,
    preferences: Option<backend::PoolPreferences>,
    check_now: Option<bool>,
) -> Result<backend::PoolReport, String> {
    if window.label() != "main" {
        return Err("Неизвестное окно.".into());
    }
    state.proxy_pool_report(preferences, check_now.unwrap_or(false))
}

#[tauri::command]
fn edit_custom_proxy(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, backend::Backend>,
    change: backend::CustomProxyChange,
) -> Result<backend::PoolReport, String> {
    if window.label() != "main" {
        return Err("Неизвестное окно.".into());
    }
    state.edit_custom_proxy(change)
}

#[tauri::command]
async fn resolve_candidates(
    state: tauri::State<'_, backend::Backend>,
    candidates: Vec<providers::Candidate>,
    quality: Option<u32>,
    anime_id: Option<u64>,
) -> Result<serde_json::Value, String> {
    #[cfg(desktop)]
    let episode = candidates
        .first()
        .map(|candidate| candidate.episode.clone());
    #[cfg(mobile)]
    let _ = anime_id;
    #[cfg(desktop)]
    if let (Some(store), Some(quality)) = (&state.downloads, quality) {
        if let Some(result) = store.playable(&candidates, quality).await {
            return Ok(result);
        }
    }
    let result = match quality {
        Some(quality) => state.resolve_quality(candidates, Some(quality)).await,
        None => state.resolve(candidates).await,
    }?;
    #[cfg(desktop)]
    if let Some(store) = &state.downloads {
        return Ok(store
            .wrap_episode(result, anime_id.zip(episode.as_deref()))
            .await);
    }
    Ok(result)
}

#[tauri::command]
async fn inspect_stream_qualities(
    state: tauri::State<'_, backend::Backend>,
    candidates: Vec<providers::Candidate>,
) -> Result<Vec<u32>, String> {
    #[cfg(desktop)]
    if let Some(store) = &state.downloads {
        if let Some(saved) = store.ready_copy(&candidates, 480).await {
            return Ok(vec![saved.quality]);
        }
    }
    state.inspect_qualities(candidates).await
}

#[derive(Deserialize)]
struct ApiRequest {
    #[serde(default = "default_api_origin")]
    origin: String,
    path: String,
    method: String,
    headers: HashMap<String, String>,
    body: Option<String>,
}

#[derive(Serialize)]
struct ApiResponse {
    status: u16,
    body: String,
}

// Preserve requests from the previous frontend during development/HMR.
fn default_api_origin() -> String {
    "https://ru.yummyani.me".into()
}

fn api_url(origin: &str, path: &str) -> Result<url::Url, String> {
    let prefix = match origin {
        "https://api.yani.tv" => "/",
        "https://old.yummyani.me" | "https://ru.yummyani.me" => "/api/",
        _ => return Err("Некорректный адрес API.".into()),
    };
    let url = url::Url::parse(&format!("{origin}{path}")).map_err(|_| "Некорректный адрес API.")?;
    if !path.starts_with(prefix)
        || !url.path().starts_with(prefix)
        || url.origin().ascii_serialization() != origin
        || url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.fragment().is_some()
    {
        return Err("Некорректный адрес API.".into());
    }
    Ok(url)
}

#[tauri::command]
async fn yummy_request(
    state: tauri::State<'_, backend::Backend>,
    request: ApiRequest,
) -> Result<ApiResponse, String> {
    let url = api_url(&request.origin, &request.path)?;
    if !matches!(
        request.method.as_str(),
        "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
    ) {
        return Err("Неизвестный метод API.".into());
    }
    let mut builder = state
        .client
        .request(
            request
                .method
                .parse::<reqwest::Method>()
                .map_err(|_| "Неизвестный метод API.")?,
            url,
        )
        .timeout(Duration::from_secs(5));
    for (name, value) in request.headers {
        if !matches!(
            name.to_ascii_lowercase().as_str(),
            "accept" | "lang" | "x-application" | "authorization" | "content-type"
        ) {
            return Err("Неизвестный заголовок API.".into());
        }
        builder = builder.header(name, value);
    }
    if let Some(body) = request.body {
        if body.len() > 1_000_000 {
            return Err("Слишком большой запрос.".into());
        }
        builder = builder.body(body);
    }
    let mut response = builder.send().await.map_err(|_| "Нет связи с Yummy.")?;
    let status = response.status().as_u16();
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "Yummy прервал ответ.")?
    {
        if bytes.len() + chunk.len() > 8_000_000 {
            return Err("Слишком большой ответ Yummy.".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(ApiResponse {
        status,
        body: String::from_utf8(bytes).map_err(|_| "Некорректный ответ Yummy.")?,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .enable_macos_default_menu(false)
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .on_page_load(|webview, payload| {
            if webview.label() == "main"
                && payload.event() == tauri::webview::PageLoadEvent::Started
            {
                keep_awake::clear(webview);
                #[cfg(target_os = "macos")]
                let _ = webview.run_on_main_thread(native_video::clear);
                #[cfg(any(target_os = "windows", target_os = "linux", target_os = "android"))]
                if let Some(window) = webview.get_webview_window("main") {
                    native_video::clear_webview(window);
                }
            }
        })
        .on_window_event(|window, event| {
            #[cfg(desktop)]
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    if let Some(webview) = window.get_webview_window("main") {
                        api.prevent_close();
                        shutdown::save_then_close(webview, false);
                    }
                }
            }
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Destroyed) {
                #[cfg(not(target_os = "android"))]
                keep_awake::window_destroyed(window);
                #[cfg(any(desktop, target_os = "android"))]
                native_video::clear();
            }
            if window.label() == "main"
                && matches!(
                    event,
                    tauri::WindowEvent::Focused(false) | tauri::WindowEvent::Destroyed
                )
            {
                let _ = cursor_visibility(window, true);
            }
        })
        .setup(|app| {
            app.manage(updates::ReleaseCache::default());
            #[cfg(desktop)]
            app.manage(shutdown::Shutdown::default());
            #[cfg(target_os = "macos")]
            if let Some(window) = app.get_webview_window("main") {
                macos_window::install(&window)?;
            }
            app.manage(discord::DiscordPresence::new());
            let backend = backend::Backend::new()?
                .with_proxy_settings(app.path().app_config_dir()?.join("proxy-disabled"));
            #[cfg(desktop)]
            let backend = {
                let store = downloads::Store::new(app.path().app_data_dir()?.join("downloads"));
                let backend = backend.with_downloads(store.clone());
                store.start(backend.clone());
                app.manage(store);
                backend
            };
            backend.start_proxy_checks();
            app.manage(backend);
            app.manage(session::SessionVault::new(
                app.path().app_data_dir()?.join("account/session-v1.json"),
            ));
            Ok(())
        })
        .register_asynchronous_uri_scheme_protocol(
            "yumiwatch-media",
            |context, request, responder| {
                if context.webview_label() != "main" {
                    responder.respond(backend::error(
                        tauri::http::StatusCode::FORBIDDEN,
                        "Unknown webview",
                    ));
                    return;
                }
                let backend = context
                    .app_handle()
                    .state::<backend::Backend>()
                    .inner()
                    .clone();
                tauri::async_runtime::spawn(async move {
                    responder.respond(backend.media(request).await);
                });
            },
        )
        .invoke_handler(tauri::generate_handler![
            discord::set_discord_presence,
            keep_awake::set_playback_awake,
            desktop_info,
            interface_scale::set_interface_scale,
            set_window_cursor_visible,
            load_account_session,
            save_account_session,
            set_window_controls_visible,
            fetch_image,
            save_poster,
            yummy_request,
            server_status::yummy_server_status,
            updates::latest_app_release,
            proxy_settings,
            proxy_pool_report,
            edit_custom_proxy,
            resolve_candidates,
            inspect_stream_qualities,
            #[cfg(desktop)]
            downloads::list_downloads,
            #[cfg(desktop)]
            downloads::enqueue_downloads,
            #[cfg(desktop)]
            downloads::change_download,
            #[cfg(desktop)]
            downloads::remove_downloads,
            #[cfg(desktop)]
            downloads::download_settings,
            #[cfg(desktop)]
            downloads::download_storage,
            #[cfg(desktop)]
            downloads::clear_download_storage,
            #[cfg(desktop)]
            downloads::prefetch_download_episode,
            #[cfg(desktop)]
            downloads::cancel_download_prefetch,
            #[cfg(desktop)]
            shutdown::window_close_saved,
            #[cfg(any(desktop, target_os = "android"))]
            native_video::native_video,
            #[cfg(any(desktop, target_os = "android"))]
            native_video::native_video_frame,
            #[cfg(target_os = "macos")]
            native_video::native_video_card_frame
        ])
        .run(tauri::generate_context!())
        .expect("Не удалось запустить YummyWatch");
}

#[cfg(test)]
mod api_tests {
    use super::*;

    #[test]
    fn accepts_only_the_three_api_origins_and_their_routes() {
        for (origin, path) in [
            ("https://api.yani.tv", "/anime?limit=1"),
            ("https://old.yummyani.me", "/api/profile/login"),
            ("https://ru.yummyani.me", "/api/anime?limit=1"),
        ] {
            assert_eq!(
                api_url(origin, path).unwrap().as_str(),
                format!("{origin}{path}")
            );
        }
        for (origin, path) in [
            ("https://old.yummyani.me.evil.test", "/api/profile"),
            ("https://user@ru.yummyani.me", "/api/profile"),
            ("https://ru.yummyani.me:444", "/api/profile"),
            ("http://ru.yummyani.me", "/api/profile"),
            ("https://ru.yummyani.me", "/profile"),
            ("https://old.yummyani.me", "/api/../profile"),
            ("https://old.yummyani.me", "/api/%2e%2e/profile"),
            ("https://old.yummyani.me", "/api/profile#token"),
            ("https://api.yani.tv", "@evil.test/profile"),
        ] {
            assert!(api_url(origin, path).is_err(), "accepted {origin}{path}");
        }
    }

    #[test]
    fn preserves_the_previous_frontends_default_origin() {
        let request: ApiRequest = serde_json::from_value(serde_json::json!({
            "path": "/api/anime", "method": "GET", "headers": {}, "body": null
        }))
        .unwrap();
        assert_eq!(
            api_url(&request.origin, &request.path).unwrap().host_str(),
            Some("ru.yummyani.me")
        );
    }
}

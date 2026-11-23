use jni::objects::{GlobalRef, JByteArray, JObject, JString, JValue};
use jni::JNIEnv;
use std::{ffi::c_void, sync::OnceLock, time::Duration};
use tauri::WebviewWindow;

async fn on_activity<T: Send + 'static>(
    window: &WebviewWindow,
    action: impl FnOnce(&mut JNIEnv<'_>, &JObject<'_>) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (send, receive) = tokio::sync::oneshot::channel();
    window
        .with_webview(move |view| {
            view.jni_handle().exec(move |env, activity, _| {
                let result = action(env, activity);
                if env.exception_check().unwrap_or(false) {
                    let _ = env.exception_clear();
                }
                let _ = send.send(result);
            });
        })
        .map_err(|error| error.to_string())?;
    tokio::time::timeout(Duration::from_secs(3), receive)
        .await
        .map_err(|_| "Не удалось подключиться к видеоповерхности Android.".to_string())?
        .map_err(|error| error.to_string())?
}

fn initialize_ffmpeg(env: &mut JNIEnv<'_>, activity: &JObject<'_>) -> Result<(), String> {
    static CONTEXT: OnceLock<GlobalRef> = OnceLock::new();
    if CONTEXT.get().is_some() {
        return Ok(());
    }

    let context = env
        .call_method(
            activity,
            "getApplicationContext",
            "()Landroid/content/Context;",
            &[],
        )
        .and_then(|value| value.l())
        .and_then(|context| env.new_global_ref(context))
        .map_err(|error| error.to_string())?;
    let vm = env.get_java_vm().map_err(|error| error.to_string())?;
    unsafe {
        // libmpv keeps libavcodec loaded for the lifetime of the process.
        let ffmpeg =
            libloading::Library::new("libavcodec.so").map_err(|error| error.to_string())?;
        type Init = unsafe extern "C" fn(*mut c_void, *mut c_void) -> i32;
        let set_vm = ffmpeg
            .get::<Init>(b"av_jni_set_java_vm\0")
            .map_err(|error| error.to_string())?;
        let set_context = ffmpeg
            .get::<Init>(b"av_jni_set_android_app_ctx\0")
            .map_err(|error| error.to_string())?;
        if set_vm(vm.get_java_vm_pointer().cast(), std::ptr::null_mut()) < 0
            || set_context(context.as_obj().as_raw().cast(), std::ptr::null_mut()) < 0
        {
            return Err("Не удалось подключить декодер Android к libmpv.".into());
        }
    }
    let _ = CONTEXT.set(context);
    Ok(())
}

pub(super) async fn open(
    window: &WebviewWindow,
    id: u32,
) -> Result<super::mpv::AndroidOutput, String> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
    loop {
        let output = on_activity(window, move |env, activity| {
            initialize_ffmpeg(env, activity)?;
            let surface = env
                .call_method(
                    activity,
                    "mpvSurface",
                    "(I)Landroid/view/Surface;",
                    &[JValue::Int(id as i32)],
                )
                .and_then(|value| value.l())
                .map_err(|error| error.to_string())?;
            if surface.is_null() {
                return Ok(None);
            }
            let surface = env
                .new_global_ref(surface)
                .map_err(|error| error.to_string())?;
            let certificates = env
                .call_method(activity, "mpvCaBundle", "()Ljava/lang/String;", &[])
                .and_then(|value| value.l())
                .map(JString::from)
                .map_err(|error| error.to_string())?;
            let certificates: String = env
                .get_string(&certificates)
                .map_err(|error| error.to_string())?
                .into();
            Ok(Some(super::mpv::AndroidOutput {
                surface,
                certificates: std::ffi::CString::new(certificates)
                    .map_err(|error| error.to_string())?,
            }))
        })
        .await?;
        if let Some(output) = output {
            return Ok(output);
        }
        if tokio::time::Instant::now() >= deadline {
            return Err("Видеоповерхность Android не появилась.".into());
        }
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
}

pub(super) async fn layout(
    window: &WebviewWindow,
    id: u32,
    visible: bool,
    geometry: super::Geometry,
) -> Result<(), String> {
    on_activity(window, move |env, activity| {
        env.call_method(
            activity,
            "layoutMpvSurface",
            "(IZDDDD)V",
            &[
                JValue::Int(id as i32),
                JValue::Bool(visible.into()),
                JValue::Double(geometry.x),
                JValue::Double(geometry.y),
                JValue::Double(geometry.width),
                JValue::Double(geometry.height),
            ],
        )
        .map(|_| ())
        .map_err(|error| error.to_string())
    })
    .await
}

pub(super) async fn close(window: &WebviewWindow, id: u32) {
    let _ = on_activity(window, move |env, activity| {
        env.call_method(
            activity,
            "closeMpvSurface",
            "(I)V",
            &[JValue::Int(id as i32)],
        )
        .map(|_| ())
        .map_err(|error| error.to_string())
    })
    .await;
}

pub(super) async fn frame(window: &WebviewWindow, id: u32) -> Result<Vec<u8>, String> {
    let (vm, frame) = on_activity(window, move |env, activity| {
        let frame = env
            .call_method(
                activity,
                "mpvFrame",
                "(I)Ljava/util/concurrent/CompletableFuture;",
                &[JValue::Int(id as i32)],
            )
            .and_then(|value| value.l())
            .and_then(|frame| env.new_global_ref(frame))
            .map_err(|error| error.to_string())?;
        let vm = env.get_java_vm().map_err(|error| error.to_string())?;
        Ok((vm, frame))
    })
    .await?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut env = vm
            .attach_current_thread()
            .map_err(|error| error.to_string())?;
        let bytes = env
            .get_static_field(
                "java/util/concurrent/TimeUnit",
                "MILLISECONDS",
                "Ljava/util/concurrent/TimeUnit;",
            )
            .and_then(|unit| unit.l())
            .and_then(|unit| {
                env.call_method(
                    frame.as_obj(),
                    "get",
                    "(JLjava/util/concurrent/TimeUnit;)Ljava/lang/Object;",
                    &[JValue::Long(1000), JValue::Object(&unit)],
                )
            })
            .and_then(|bytes| bytes.l());
        match bytes {
            Ok(bytes) if !bytes.is_null() => env
                .convert_byte_array(JByteArray::from(bytes))
                .map_err(|error| error.to_string()),
            _ => {
                if env.exception_check().unwrap_or(false) {
                    let _ = env.exception_clear();
                }
                Ok(Vec::new())
            }
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

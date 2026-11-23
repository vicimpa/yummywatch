package app.yumiwatch.desktop

import android.app.UiModeManager
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.view.KeyEvent
import android.view.PixelCopy
import android.view.Surface
import android.view.SurfaceView
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.WebView
import android.widget.FrameLayout
import androidx.activity.enableEdgeToEdge
import androidx.annotation.Keep
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.concurrent.CompletableFuture

class MainActivity : TauriActivity() {
  private var televisionWebView: WebView? = null
  private var appWebView: WebView? = null
  private lateinit var videoHost: FrameLayout
  private val videoSurfaces = mutableMapOf<Int, SurfaceView>()
  private val television by lazy {
    getSystemService(UiModeManager::class.java)?.currentModeType == Configuration.UI_MODE_TYPE_TELEVISION ||
      packageManager.hasSystemFeature(PackageManager.FEATURE_LEANBACK)
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    if (!television) enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    if (television) {
      requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
      window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING)
      val insets = WindowCompat.getInsetsController(window, window.decorView)
      insets.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
      insets.hide(WindowInsetsCompat.Type.systemBars())
    }
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    appWebView = webView
    if (television) {
      televisionWebView = webView
      webView.settings.userAgentString += " YummyWatchTV"
      webView.isFocusableInTouchMode = true
      var imeVisible = false
      ViewCompat.setOnApplyWindowInsetsListener(webView) { view, insets ->
        val visible = insets.isVisible(WindowInsetsCompat.Type.ime())
        if (visible != imeVisible) {
          imeVisible = visible
          webView.evaluateJavascript(
            "document.documentElement.dataset.tvIme = '$visible';" +
              if (visible) "" else "window.dispatchEvent(new Event('yumiwatch:tv-ime-hidden'));",
            null
          )
        }
        ViewCompat.onApplyWindowInsets(view, insets)
      }
      webView.post { webView.requestFocus() }
    }
  }

  @Keep
  fun mpvSurface(id: Int): Surface? {
    val webView = appWebView ?: return null
    val parent = webView.parent as? ViewGroup ?: return null
    if (!::videoHost.isInitialized || videoHost.parent !== parent) {
      videoHost = FrameLayout(this)
      videoHost.isFocusable = false
      parent.addView(videoHost, parent.indexOfChild(webView), ViewGroup.LayoutParams(-1, -1))
    }
    val view = videoSurfaces.getOrPut(id) {
      webView.setBackgroundColor(Color.TRANSPARENT)
      SurfaceView(this).also {
        it.isFocusable = false
        videoHost.addView(it, FrameLayout.LayoutParams(1, 1))
        it.translationX = -1f
        it.translationY = -1f
      }
    }
    return view.holder.surface.takeIf { it.isValid }
  }

  @Keep
  fun mpvCaBundle(): String {
    val bundle = File(cacheDir, "mpv-ca.pem")
    if (!bundle.exists()) {
      val staged = File(cacheDir, "mpv-ca.tmp")
      assets.open("mpv-ca.pem").use { input -> staged.outputStream().use { input.copyTo(it) } }
      check(staged.renameTo(bundle)) { "Could not prepare libmpv TLS certificates" }
    }
    return bundle.absolutePath
  }

  @Keep
  fun layoutMpvSurface(id: Int, visible: Boolean, x: Double, y: Double, width: Double, height: Double) {
    val view = videoSurfaces[id] ?: return
    val browser = appWebView ?: return
    val outputWidth = (width * browser.width).toInt().coerceAtLeast(1)
    val outputHeight = (height * browser.height).toInt().coerceAtLeast(1)
    // Keep the standby decoder's surface attached during a quality change.
    view.translationX = if (visible) (x * browser.width + browser.left).toFloat() else -outputWidth.toFloat()
    view.translationY = if (visible) (y * browser.height + browser.top).toFloat() else -outputHeight.toFloat()
    view.layoutParams = FrameLayout.LayoutParams(outputWidth, outputHeight)
  }

  @Keep
  fun closeMpvSurface(id: Int) {
    val view = videoSurfaces.remove(id) ?: return
    videoHost.removeView(view)
    if (videoSurfaces.isEmpty()) (videoHost.parent as? ViewGroup)?.removeView(videoHost)
  }

  @Keep
  fun mpvFrame(id: Int): CompletableFuture<ByteArray?> {
    val frame = CompletableFuture<ByteArray?>()
    val view = videoSurfaces[id]
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O || view == null ||
        !view.holder.surface.isValid || view.width <= 1 || view.height <= 1) {
      frame.complete(null)
      return frame
    }
    val scale = minOf(1.0, 640.0 / maxOf(view.width, view.height))
    val bitmap = Bitmap.createBitmap(
      (view.width * scale).toInt().coerceAtLeast(1),
      (view.height * scale).toInt().coerceAtLeast(1),
      Bitmap.Config.ARGB_8888
    )
    try {
      PixelCopy.request(view, bitmap, { result ->
        val bytes = if (result == PixelCopy.SUCCESS) {
          val output = ByteArrayOutputStream()
          if (bitmap.compress(Bitmap.CompressFormat.JPEG, 76, output)) output.toByteArray() else null
        } else null
        bitmap.recycle()
        frame.complete(bytes)
      }, Handler(mainLooper))
    } catch (_: IllegalArgumentException) {
      bitmap.recycle()
      frame.complete(null)
    }
    return frame
  }

  override fun dispatchKeyEvent(event: KeyEvent): Boolean {
    val webView = televisionWebView ?: return super.dispatchKeyEvent(event)
    val action = when (event.keyCode) {
      KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, KeyEvent.KEYCODE_HEADSETHOOK -> "toggle"
      KeyEvent.KEYCODE_MEDIA_PLAY -> "play"
      KeyEvent.KEYCODE_MEDIA_PAUSE -> "pause"
      KeyEvent.KEYCODE_MEDIA_REWIND -> "rewind"
      KeyEvent.KEYCODE_MEDIA_FAST_FORWARD -> "forward"
      KeyEvent.KEYCODE_MEDIA_PREVIOUS -> "previous"
      KeyEvent.KEYCODE_MEDIA_NEXT -> "next"
      else -> return super.dispatchKeyEvent(event)
    }
    if (event.action == KeyEvent.ACTION_DOWN &&
        (event.repeatCount == 0 || action == "forward" || action == "rewind")) {
      webView.evaluateJavascript(
        "window.dispatchEvent(new CustomEvent('yumiwatch:tv-media', { detail: '$action' }));",
        null
      )
    }
    return true
  }
}

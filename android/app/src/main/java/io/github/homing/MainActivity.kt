package io.github.homing

import android.Manifest
import android.annotation.SuppressLint
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.webkit.JsResult
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.activity.addCallback
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.net.toUri
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import org.json.JSONObject

/** 直接嵌网页版：列表、会话、搜索、级别、AI 这些都复用，App 只负责通知。 */
class MainActivity : ComponentActivity() {
    private val prefs by lazy { Prefs(this) }
    private lateinit var web: WebView
    private val askNotify = registerForActivityResult(ActivityResultContracts.RequestPermission()) {}

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        if (!prefs.loggedIn) {
            startActivity(Intent(this, SettingsActivity::class.java))
            finish()
            return
        }
        web = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            webViewClient = Client()
            webChromeClient = Chrome()
        }
        val root = FrameLayout(this).apply { addView(web) }
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val b = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime()
                    or WindowInsetsCompat.Type.displayCutout())
            v.setPadding(b.left, b.top, b.right, b.bottom)
            WindowInsetsCompat.CONSUMED
        }
        setContentView(root)

        // 网页自己用 history 管理浮层和视图，返回键交给它逐层退。
        // 脚本里 pushState 压的条目（比如从通知直接打开详情）Chromium 视为可跳过，
        // canGoBack() 看不到，所以再问一次网页：有浮层就关，不在列表就回列表，都没有才退出
        onBackPressedDispatcher.addCallback(this) {
            if (web.canGoBack()) return@addCallback web.goBack()
            web.evaluateJavascript(BACK_JS) { handled -> if (handled != "true") moveTaskToBack(true) }
        }

        if (savedInstanceState == null) open(intent.getStringExtra(Notifier.EXTRA_PATH))
        else web.restoreState(savedInstanceState)

        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            askNotify.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        intent.getStringExtra(Notifier.EXTRA_PATH)?.let(::open)
    }

    /** 从通知点进来时跳到对应消息；页面已经打开的话只改 hash，不整页重载 */
    private fun open(path: String?) {
        val base = prefs.server.trimEnd('/')
        val loaded = web.url?.startsWith(base) == true
        if (path != null && loaded) web.evaluateJavascript("location.hash=${JSONObject.quote(path)}", null)
        else web.loadUrl("$base/${path.orEmpty()}")
    }

    override fun onStop() {
        super.onStop()
        // 在前台时网页是实时的，用户已经看过了：记为已见，并撤掉在网页上读过的通知
        if (::web.isInitialized && prefs.loggedIn) PollWorker.runNow(this, quiet = true)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        if (::web.isInitialized) web.saveState(outState)
    }

    override fun onDestroy() {
        if (::web.isInitialized) web.destroy()
        super.onDestroy()
    }

    /**
     * 网页里删除、退出登录前都会 confirm()。WebView 默认不弹框，confirm() 直接返回 false，
     * 操作就被静默取消了，所以这里接管成系统对话框。
     */
    private inner class Chrome : WebChromeClient() {
        override fun onJsConfirm(view: WebView, url: String, message: String, result: JsResult): Boolean {
            AlertDialog.Builder(this@MainActivity)
                .setMessage(message)
                .setPositiveButton(android.R.string.ok) { _, _ -> result.confirm() }
                .setNegativeButton(android.R.string.cancel) { _, _ -> result.cancel() }
                .setOnCancelListener { result.cancel() }
                .show()
            return true
        }

        override fun onJsAlert(view: WebView, url: String, message: String, result: JsResult): Boolean {
            AlertDialog.Builder(this@MainActivity)
                .setMessage(message)
                .setPositiveButton(android.R.string.ok) { _, _ -> result.confirm() }
                .setOnCancelListener { result.confirm() }
                .show()
            return true
        }
    }

    private inner class Client : WebViewClient() {
        // 本站的页面在 App 里打开，消息里的外部链接交给浏览器
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            if (request.url.host == prefs.server.toUri().host) return false
            runCatching { startActivity(Intent(Intent.ACTION_VIEW, request.url)) }
            return true
        }
    }

    private companion object {
        val BACK_JS = """
            (() => {
              if (history.state && history.state.depth) { history.back(); return true; }
              // #/m/<id> 是「全部」列表 + 打开某条，详情关掉后它就是列表本身
              if (!/^(#\/?(all)?|#\/m\/\d+)?$/.test(location.hash)) { location.hash = '#/'; return true; }
              return false;
            })()
        """.trimIndent()
    }
}

package io.github.homing

import android.content.Intent
import android.os.Bundle
import android.provider.Settings
import android.text.format.DateUtils
import android.view.View
import android.webkit.CookieManager
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.core.app.NotificationManagerCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.work.WorkManager
import java.io.IOException
import kotlin.concurrent.thread

class SettingsActivity : ComponentActivity() {
    private val prefs by lazy { Prefs(this) }
    private lateinit var server: EditText
    private lateinit var password: EditText
    private lateinit var login: Button
    private lateinit var status: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_settings)
        val root = findViewById<View>(R.id.root)
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val b = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime())
            v.setPadding(b.left, b.top, b.right, b.bottom)
            WindowInsetsCompat.CONSUMED
        }
        server = findViewById(R.id.server)
        password = findViewById(R.id.password)
        login = findViewById(R.id.login)
        status = findViewById(R.id.status)

        server.setText(prefs.server)
        login.setOnClickListener { doLogin() }
        findViewById<Button>(R.id.check).setOnClickListener {
            PollWorker.runNow(this)
            Toast.makeText(this, "正在检查…", Toast.LENGTH_SHORT).show()
        }
        findViewById<Button>(R.id.channels).setOnClickListener {
            startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                .putExtra(Settings.EXTRA_APP_PACKAGE, packageName))
        }
        findViewById<Button>(R.id.open).setOnClickListener { openMain() }
        findViewById<Button>(R.id.logout).setOnClickListener { logout() }

        // 检查一结束就刷新状态
        WorkManager.getInstance(this).getWorkInfosForUniqueWorkLiveData(PollWorker.NOW)
            .observe(this) { render() }
        if (intent.action == ACTION_CHECK && prefs.loggedIn) PollWorker.runNow(this)
    }

    override fun onResume() {
        super.onResume()
        render()
    }

    private fun render() {
        val loggedIn = prefs.loggedIn
        password.hint = if (loggedIn) "已登录，重新登录时填写" else "登录密码"
        login.text = if (loggedIn) "重新登录" else "登录"
        listOf(R.id.check, R.id.open, R.id.logout).forEach { findViewById<View>(it).isEnabled = loggedIn }
        status.text = buildString {
            if (!loggedIn) {
                append("未登录")
                return@buildString
            }
            append("上次检查：")
            val ago = System.currentTimeMillis() - prefs.lastCheck
            append(when {
                prefs.lastCheck == 0L -> "还没有"
                ago < DateUtils.MINUTE_IN_MILLIS -> "刚刚"
                else -> DateUtils.getRelativeTimeSpanString(prefs.lastCheck, System.currentTimeMillis(),
                    DateUtils.MINUTE_IN_MILLIS)
            })
            append(if (prefs.lastError.isEmpty()) "，正常" else "，失败：${prefs.lastError}")
            if (!NotificationManagerCompat.from(this@SettingsActivity).areNotificationsEnabled()) {
                append("\n通知权限已关闭，收不到提醒。点「通知设置」打开。")
            }
        }
    }

    private fun doLogin() {
        val url = server.text.toString().trim().trimEnd('/')
        val pw = password.text.toString()
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            server.error = "以 http:// 或 https:// 开头"
            return
        }
        if (pw.isEmpty()) {
            password.error = "请输入密码"
            return
        }
        login.isEnabled = false
        val serverChanged = url != prefs.server || !prefs.loggedIn
        thread {
            val error = try {
                Api(this).login(url, pw)
                null
            } catch (e: IOException) {
                e.message ?: e.javaClass.simpleName
            }
            runOnUiThread {
                login.isEnabled = true
                if (error != null) {
                    status.text = "登录失败：$error"
                    return@runOnUiThread
                }
                // 游标是服务端的消息 id，换了服务器就不通用了，从头来
                if (serverChanged) {
                    prefs.cursor = -1
                    prefs.notified = emptySet()
                }
                Notifier.clearLoginExpired(this)
                PollWorker.schedule(this)
                PollWorker.runNow(this)
                password.text.clear()
                openMain()
            }
        }
    }

    private fun logout() {
        PollWorker.cancel(this)
        prefs.logout()
        NotificationManagerCompat.from(this).cancelAll()
        runCatching { CookieManager.getInstance().removeAllCookies(null) }
        render()
    }

    private fun openMain() {
        startActivity(Intent(this, MainActivity::class.java))
        finish()
    }

    companion object {
        const val ACTION_CHECK = "io.github.homing.CHECK"
    }
}

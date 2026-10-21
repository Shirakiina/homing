package io.github.homing

import android.content.Context
import android.webkit.CookieManager
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

class ApiException(message: String, val code: Int = 0) : IOException(message)

/** Homing 服务端的 HTTP 接口。都是阻塞调用，别在主线程用。 */
class Api(private val ctx: Context) {
    private val prefs = Prefs(ctx)

    /** 用密码换 homing_session，同时写进 WebView，网页那边不用再登录一次。 */
    fun login(server: String, password: String) {
        val conn = open("POST", "$server/api/login", session = "")
        send(conn, JSONObject().put("password", password))
        val code = conn.responseCode
        if (code != 200) throw ApiException(errorOf(conn, code), code)
        val session = conn.headerFields.entries
            .filter { it.key.equals("Set-Cookie", ignoreCase = true) }
            .flatMap { it.value }
            .firstNotNullOfOrNull { SESSION_RE.find(it)?.groupValues?.get(1) }
            ?: throw ApiException("服务器没有返回登录会话")
        prefs.server = server
        prefs.password = password
        prefs.session = session
        syncWebCookie(server, session)
    }

    fun messages(before: Long? = null, limit: Int = 100): JSONObject =
        JSONObject(call("GET", "/api/messages?limit=$limit" + (before?.let { "&before=$it" } ?: "")))

    fun levels(): JSONArray = JSONArray(call("GET", "/api/levels"))

    fun markRead(ids: Collection<Long>) {
        call("POST", "/api/read", JSONObject().put("ids", JSONArray(ids)))
    }

    private fun call(method: String, path: String, body: JSONObject? = null): String {
        var relogged = false
        while (true) {
            val conn = open(method, prefs.server + path, prefs.session)
            if (body != null) send(conn, body)
            val code = conn.responseCode
            // 会话过期或服务端改过密码：用存的密码重登一次。密码也不对的话 login 会抛 401
            if (code == 401 && !relogged && prefs.password.isNotEmpty()) {
                login(prefs.server, prefs.password)
                relogged = true
                continue
            }
            if (code !in 200..299) throw ApiException(errorOf(conn, code), code)
            return conn.inputStream.use { it.readBytes().decodeToString() }
        }
    }

    private fun open(method: String, url: String, session: String) =
        (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = 15_000
            readTimeout = 20_000
            setRequestProperty("Accept", "application/json")
            setRequestProperty("User-Agent", "notice-android")
            if (session.isNotEmpty()) setRequestProperty("Cookie", "homing_session=$session")
        }

    /** 管理接口只收 JSON（服务端用来防 CSRF） */
    private fun send(conn: HttpURLConnection, body: JSONObject) {
        conn.doOutput = true
        conn.setRequestProperty("Content-Type", "application/json; charset=utf-8")
        conn.outputStream.use { it.write(body.toString().toByteArray()) }
    }

    private fun errorOf(conn: HttpURLConnection, code: Int): String {
        val text = conn.errorStream?.use { it.readBytes().decodeToString() }.orEmpty()
        val msg = runCatching { JSONObject(text).optString("error") }.getOrNull()
        return msg?.ifEmpty { null } ?: text.take(100).ifEmpty { "HTTP $code" }
    }

    private fun syncWebCookie(server: String, session: String) {
        // 系统 WebView 正在更新时 getInstance 会抛异常；网页自己还能登录，不影响通知
        runCatching {
            CookieManager.getInstance().apply {
                setCookie(server, "homing_session=$session; Path=/; Max-Age=${30 * 86400}")
                flush()
            }
        }
    }

    private companion object {
        val SESSION_RE = Regex("""homing_session=([^;]+)""")
    }
}


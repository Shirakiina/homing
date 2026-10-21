package io.github.homing

import android.content.Context
import androidx.core.content.edit

/** 所有本地状态。存在应用私有目录，不参与备份（见 Manifest allowBackup）。 */
class Prefs(ctx: Context) {
    private val sp = ctx.getSharedPreferences("homing", Context.MODE_PRIVATE)

    var server: String
        get() = sp.getString("server", DEFAULT_SERVER)!!
        set(v) = sp.edit { putString("server", v) }

    /** 存密码是为了会话到期（30 天）后能自动重新登录，否则过期那天起就静默收不到通知。 */
    var password: String
        get() = sp.getString("password", "")!!
        set(v) = sp.edit { putString("password", v) }

    /** homing_session cookie 的值 */
    var session: String
        get() = sp.getString("session", "")!!
        set(v) = sp.edit { putString("session", v) }

    /** id ≤ cursor 的消息都处理过了。-1 = 刚登录，还没定基线。 */
    var cursor: Long
        get() = sp.getLong("cursor", -1)
        set(v) = sp.edit { putLong("cursor", v) }

    /** cursor 之后已经弹过的消息（cursor 被 AI 未整理完的消息卡住时，避免后面的重复弹） */
    var notified: Set<Long>
        get() = sp.getString("notified", "")!!.split(',').mapNotNull { it.toLongOrNull() }.toSet()
        set(v) = sp.edit { putString("notified", v.joinToString(",")) }

    /** /api/levels 的缓存，用来给通知上色 */
    var levels: String
        get() = sp.getString("levels", "[]")!!
        set(v) = sp.edit { putString("levels", v) }

    var lastCheck: Long
        get() = sp.getLong("last_check", 0)
        set(v) = sp.edit { putLong("last_check", v) }

    /** 上次检查的错误，空 = 成功 */
    var lastError: String
        get() = sp.getString("last_error", "")!!
        set(v) = sp.edit { putString("last_error", v) }

    /** 已经弹过「登录失效」的提醒，恢复前不再重复弹 */
    var authAlerted: Boolean
        get() = sp.getBoolean("auth_alerted", false)
        set(v) = sp.edit { putBoolean("auth_alerted", v) }

    val loggedIn get() = session.isNotEmpty()

    fun logout() = sp.edit {
        remove("password"); remove("session"); remove("cursor"); remove("notified")
        remove("last_check"); remove("last_error"); remove("auth_alerted")
    }

    companion object {
        const val DEFAULT_SERVER = ""
    }
}

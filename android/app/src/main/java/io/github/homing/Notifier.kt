package io.github.homing

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationCompat.MessagingStyle
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import androidx.core.content.ContextCompat
import androidx.core.graphics.toColorInt
import org.json.JSONArray
import org.json.JSONObject

/**
 * 通知按级别分渠道，响铃、横幅、免打扰例外这些都在系统的渠道设置里按渠道调。
 * 渠道名用内置级别的默认名；服务端改了级别名称不会同步过来。
 */
object Notifier {
    private const val CH_URGENT = "urgent"
    private const val CH_REMIND = "remind"
    private const val CH_CHAT = "chat"
    private const val CH_NORMAL = "normal"
    private const val CH_APP = "app"

    const val TAG_MSG = "m"
    const val TAG_CONV = "c"
    private const val TAG_MORE = "more"
    private const val TAG_APP = "app"

    const val EXTRA_IDS = "ids"
    const val EXTRA_TAG = "tag"
    const val EXTRA_NID = "nid"
    const val EXTRA_PATH = "path"

    /** 单条消息最多弹这么多，再多合并成一条「另有 N 条」，免得一次响几十声 */
    private const val MAX_SINGLE = 10
    private const val CONV_KEEP = 10

    fun createChannels(ctx: Context) {
        val ch = { id: String, name: String, importance: Int, desc: String ->
            NotificationChannel(id, name, importance).apply { description = desc }
        }
        ctx.getSystemService(NotificationManager::class.java).createNotificationChannels(listOf(
            ch(CH_URGENT, "重要", NotificationManager.IMPORTANCE_HIGH, "级别为「重要」的消息，如告警、构建失败"),
            ch(CH_REMIND, "提醒", NotificationManager.IMPORTANCE_HIGH, "级别为「提醒」的消息"),
            ch(CH_CHAT, "聊天", NotificationManager.IMPORTANCE_HIGH, "微信、WhatsApp 等聊天消息，按会话合并"),
            ch(CH_NORMAL, "普通", NotificationManager.IMPORTANCE_DEFAULT, "其它级别的消息"),
            ch(CH_APP, "应用状态", NotificationManager.IMPORTANCE_DEFAULT, "登录失效等需要处理的问题"),
        ))
    }

    fun post(ctx: Context, msgs: List<JSONObject>) {
        if (msgs.isEmpty()) return
        val colors = levelColors(ctx)
        val (chats, others) = msgs.partition { it.optString("conv").isNotEmpty() }
        chats.groupBy { it.getString("conv") }.forEach { (conv, list) -> postConversation(ctx, conv, list) }
        val shown = others.takeLast(MAX_SINGLE)
        shown.forEach { postSingle(ctx, it, colors) }
        if (others.size > shown.size) postMore(ctx, others.size - shown.size)
    }

    private fun postSingle(ctx: Context, m: JSONObject, colors: Map<String, Int>) {
        val id = m.id
        val level = m.optString("level")
        val title = m.optString("ai_title").ifEmpty { m.optString("title") }.ifEmpty { m.optString("channel_name") }
        val body = m.optString("ai_summary").ifEmpty { m.optString("body") }
        val n = NotificationCompat.Builder(ctx, channelOf(level))
            .setSmallIcon(R.drawable.ic_stat_bell)
            .setColor(colors[level] ?: ACCENT)
            .setContentTitle(title)
            .setContentText(plain(body))
            .setStyle(NotificationCompat.BigTextStyle().bigText(plain(body, keepLines = true)))
            .setSubText(m.optString("channel_name"))
            .setWhen(millis(m)).setShowWhen(true)
            .setAutoCancel(true)
            .setContentIntent(open(ctx, "#/m/$id"))
            .addAction(0, "已读", markRead(ctx, longArrayOf(id), TAG_MSG, id.toInt()))
            .addExtras(idsExtra(longArrayOf(id)))
            .build()
        show(ctx, TAG_MSG, id.toInt(), n)
    }

    /** 同一会话的消息合并成一条聊天样式的通知，新消息追加到已有那条上 */
    private fun postConversation(ctx: Context, conv: String, list: List<JSONObject>) {
        val nid = conv.hashCode()
        val existing = ctx.getSystemService(NotificationManager::class.java).activeNotifications
            .firstOrNull { it.tag == TAG_CONV && it.id == nid }?.notification
        val style = existing?.let { MessagingStyle.extractMessagingStyleFromNotification(it) }
            ?: MessagingStyle(Person.Builder().setName("我").build())
        val last = list.last()
        val sender = Person.Builder().setKey(conv)
            .setName(last.optString("conv_name").ifEmpty { last.optString("title") }).build()
        // 聊天消息 AI 不改写，直接用原文
        list.forEach { style.addMessage(plain(it.optString("body")), millis(it), sender) }
        while (style.messages.size > CONV_KEEP) style.messages.removeAt(0)
        val ids = ((existing?.extras?.getLongArray(EXTRA_IDS) ?: LongArray(0)) + list.map { it.id }).takeLast(50)
            .toLongArray()
        val n = NotificationCompat.Builder(ctx, CH_CHAT)
            .setSmallIcon(R.drawable.ic_stat_bell)
            .setColor(ACCENT)
            .setStyle(style)
            .setSubText(last.optString("channel_name"))
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setWhen(millis(last)).setShowWhen(true)
            .setAutoCancel(true)
            .setContentIntent(open(ctx, "#/m/${last.id}"))
            .addAction(0, "已读", markRead(ctx, ids, TAG_CONV, nid))
            .addExtras(idsExtra(ids))
            .build()
        show(ctx, TAG_CONV, nid, n)
    }

    private fun postMore(ctx: Context, count: Int) {
        val n = NotificationCompat.Builder(ctx, CH_NORMAL)
            .setSmallIcon(R.drawable.ic_stat_bell)
            .setColor(ACCENT)
            .setContentTitle("另有 $count 条新消息")
            .setContentText("点此查看全部未读")
            .setAutoCancel(true)
            .setContentIntent(open(ctx, "#/unread"))
            .build()
        show(ctx, TAG_MORE, 0, n)
    }

    fun loginExpired(ctx: Context) {
        val prefs = Prefs(ctx)
        if (prefs.authAlerted || !NotificationManagerCompat.from(ctx).areNotificationsEnabled()) return
        val intent = Intent(ctx, SettingsActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val n = NotificationCompat.Builder(ctx, CH_APP)
            .setSmallIcon(R.drawable.ic_stat_bell)
            .setColor(ACCENT)
            .setContentTitle("归巢登录已失效")
            .setContentText("重新登录前收不到新消息提醒")
            .setAutoCancel(true)
            .setContentIntent(PendingIntent.getActivity(ctx, 0, intent, PI_FLAGS))
            .build()
        show(ctx, TAG_APP, 1, n)
        prefs.authAlerted = true
    }

    fun clearLoginExpired(ctx: Context) {
        NotificationManagerCompat.from(ctx).cancel(TAG_APP, 1)
        Prefs(ctx).authAlerted = false
    }

    /** 撤掉在网页上已读、被删除、或被 AI 判为垃圾的消息的通知 */
    fun dismissRead(ctx: Context, items: List<JSONObject>) {
        if (items.isEmpty()) return
        val read = items.associate { it.id to (it.optInt("is_read") == 1) }
        val oldest = items.minOf { it.id }
        // 比这批数据还旧的不知道状态，保留；在范围内但不在列表里的，就是被删了或被过滤了
        fun done(id: Long) = id >= oldest && read[id] != false
        val nm = ctx.getSystemService(NotificationManager::class.java)
        for (sbn in nm.activeNotifications) {
            if (sbn.tag != TAG_MSG && sbn.tag != TAG_CONV) continue
            val ids = sbn.notification.extras.getLongArray(EXTRA_IDS) ?: continue
            if (ids.all(::done)) nm.cancel(sbn.tag, sbn.id)
        }
    }

    /** 用户没给通知权限就什么都不发（Android 13 起需要运行时授权） */
    private fun show(ctx: Context, tag: String, id: Int, n: Notification) {
        if (ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS)
            != PackageManager.PERMISSION_GRANTED) return
        NotificationManagerCompat.from(ctx).notify(tag, id, n)
    }

    private fun channelOf(level: String) = when (level) {
        "error" -> CH_URGENT
        "warning" -> CH_REMIND
        else -> CH_NORMAL
    }

    private fun levelColors(ctx: Context): Map<String, Int> {
        val arr = runCatching { JSONArray(Prefs(ctx).levels) }.getOrNull() ?: return emptyMap()
        return (0 until arr.length()).map { arr.getJSONObject(it) }.mapNotNull { lv ->
            runCatching { lv.getString("key") to lv.getString("color").toColorInt() }.getOrNull()
        }.toMap()
    }

    private fun open(ctx: Context, path: String): PendingIntent {
        // action 带上路径，让每条通知的 PendingIntent 各不相同，不会互相覆盖
        val intent = Intent(ctx, MainActivity::class.java)
            .setAction("open:$path")
            .putExtra(EXTRA_PATH, path)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return PendingIntent.getActivity(ctx, 0, intent, PI_FLAGS)
    }

    private fun markRead(ctx: Context, ids: LongArray, tag: String, nid: Int): PendingIntent {
        val intent = Intent(ctx, MarkReadReceiver::class.java)
            .setAction("read:$tag:$nid")
            .putExtra(EXTRA_IDS, ids).putExtra(EXTRA_TAG, tag).putExtra(EXTRA_NID, nid)
        return PendingIntent.getBroadcast(ctx, 0, intent, PI_FLAGS)
    }

    /** 通知里记下对应的消息 id，用来判断网页上读过没有 */
    private fun idsExtra(ids: LongArray) = Bundle().apply { putLongArray(EXTRA_IDS, ids) }

    private fun millis(m: JSONObject) = (m.optDouble("ts") * 1000).toLong()

    /** 去掉 Markdown 标记。# 和 > 只去行首的，强调只去成对的，「#42」「test_notify」这种正文不动 */
    fun plain(s: String, keepLines: Boolean = false): String {
        val t = s.replace(Regex("```[\\s\\S]*?```"), " ")
            .replace(Regex("""!?\[([^\]]*)]\([^)]*\)"""), "$1")
            .replace(Regex("(?m)^[ \\t]*(#{1,6}|>+)[ \\t]*"), "")
            .replace(Regex("\\*\\*|__|~~|`"), "")
        return if (keepLines) t.replace(Regex("[ \\t]+"), " ").replace(Regex("\\n{3,}"), "\n\n").trim()
               else t.replace(Regex("\\s+"), " ").trim()
    }

    private val ACCENT = "#5B5BD6".toColorInt()
    private const val PI_FLAGS = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
}

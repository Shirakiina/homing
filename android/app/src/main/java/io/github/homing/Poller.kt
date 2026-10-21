package io.github.homing

import android.content.Context
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * 拉一次新消息并弹通知。
 *
 * 没有常驻连接：由 WorkManager 每 15 分钟调度一次，系统会把它和其它任务合并执行，
 * 息屏久了（Doze）还会推迟到维护窗口。实时性换省电，这是有意的取舍。
 */
class Poller(private val ctx: Context) {
    private val prefs = Prefs(ctx)
    private val api = Api(ctx)

    /**
     * @param quiet 只把现有消息记为已见、撤掉已读的通知，不弹新的。
     *              App 在前台时网页是实时的，用户已经看到了，切到后台时调用。
     */
    fun run(quiet: Boolean) = synchronized(LOCK) {
        if (!prefs.loggedIn) return
        try {
            runCatching { prefs.levels = api.levels().toString() }
            sync(quiet)
            prefs.lastError = ""
            if (prefs.authAlerted) Notifier.clearLoginExpired(ctx)
        } catch (e: ApiException) {
            prefs.lastError = e.message ?: "HTTP ${e.code}"
            if (e.code == 401) Notifier.loginExpired(ctx)
        } catch (e: IOException) {
            prefs.lastError = "网络错误：${e.message ?: e.javaClass.simpleName}"
        } finally {
            prefs.lastCheck = System.currentTimeMillis()
        }
    }

    private fun sync(quiet: Boolean) {
        val cursor = prefs.cursor
        val items = fetchSince(cursor)
        if (cursor < 0) {
            // 刚登录：之前的消息不补弹，只从现在开始
            prefs.cursor = items.maxOfOrNull { it.id } ?: 0
            return
        }
        val now = System.currentTimeMillis() / 1000.0
        // 开了 AI 时，新消息要等整理完才知道是不是垃圾（服务端弹系统通知也是这样等的）。
        // 卡住超过 10 分钟（比如中途关了 AI）就不等了。
        fun waiting(m: JSONObject) =
            m.optString("ai_status") == "pending" && now - m.optDouble("ts") < AI_WAIT_SECONDS
        val fresh = items.filter { it.id > cursor }
        val notified = prefs.notified
        val ready = fresh.filter { !waiting(it) && it.optInt("is_read") == 0 && it.id !in notified }
        if (!quiet) Notifier.post(ctx, ready.sortedBy { it.id })

        val waitingIds = fresh.filter(::waiting).map { it.id }
        val next = if (waitingIds.isEmpty()) maxOf(cursor, fresh.maxOfOrNull { it.id } ?: cursor)
                   else waitingIds.min() - 1
        prefs.cursor = next
        prefs.notified = (notified + ready.map { it.id }).filter { it > next }.toSet()
        Notifier.dismissRead(ctx, items)
    }

    /** 从最新往回翻页，翻过 cursor 为止。至少拿一页，用来核对已弹通知的已读状态。 */
    private fun fetchSince(cursor: Long): List<JSONObject> {
        val items = mutableListOf<JSONObject>()
        var before: Long? = null
        while (true) {
            val page = api.messages(before)
            val arr = page.getJSONArray("items")
            for (i in 0 until arr.length()) items += arr.getJSONObject(i)
            val oldest = items.lastOrNull()?.id ?: break
            if (!page.optBoolean("has_more") || oldest <= cursor || items.size >= MAX_FETCH) break
            before = oldest
        }
        return items
    }

    companion object {
        private val LOCK = Any()
        private const val AI_WAIT_SECONDS = 600
        private const val MAX_FETCH = 500
    }
}

val JSONObject.id: Long get() = getLong("id")

class PollWorker(ctx: Context, params: WorkerParameters) : Worker(ctx, params) {
    // 出错也返回 success：错误记在设置页，下一个周期自然会重试
    override fun doWork(): Result {
        Poller(applicationContext).run(inputData.getBoolean(KEY_QUIET, false))
        return Result.success()
    }

    companion object {
        private const val KEY_QUIET = "quiet"
        private val online = Constraints(requiredNetworkType = NetworkType.CONNECTED)

        fun schedule(ctx: Context) {
            WorkManager.getInstance(ctx).enqueueUniquePeriodicWork(
                "poll", ExistingPeriodicWorkPolicy.KEEP,
                PeriodicWorkRequestBuilder<PollWorker>(15, TimeUnit.MINUTES).setConstraints(online).build())
        }

        fun runNow(ctx: Context, quiet: Boolean = false) {
            WorkManager.getInstance(ctx).enqueueUniqueWork(
                NOW, ExistingWorkPolicy.APPEND_OR_REPLACE,
                OneTimeWorkRequestBuilder<PollWorker>()
                    .setInputData(workDataOf(KEY_QUIET to quiet)).setConstraints(online).build())
        }

        fun cancel(ctx: Context) = WorkManager.getInstance(ctx).cancelAllWork()

        const val NOW = "poll-now"
    }
}

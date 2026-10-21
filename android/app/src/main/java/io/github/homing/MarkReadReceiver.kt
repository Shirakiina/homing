package io.github.homing

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationManagerCompat
import java.io.IOException
import kotlin.concurrent.thread

/** 通知上的「已读」按钮 */
class MarkReadReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        val ids = intent.getLongArrayExtra(Notifier.EXTRA_IDS) ?: return
        NotificationManagerCompat.from(ctx)
            .cancel(intent.getStringExtra(Notifier.EXTRA_TAG), intent.getIntExtra(Notifier.EXTRA_NID, 0))
        val pending = goAsync()
        thread {
            try {
                Api(ctx).markRead(ids.toList())
            } catch (_: IOException) {
                // 没标上也无妨：通知已撤，不会再弹，只是网页里仍显示未读
            } finally {
                pending.finish()
            }
        }
    }
}

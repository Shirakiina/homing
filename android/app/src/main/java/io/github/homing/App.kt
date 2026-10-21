package io.github.homing

import android.app.Application

class App : Application() {
    override fun onCreate() {
        super.onCreate()
        Notifier.createChannels(this)
        if (Prefs(this).loggedIn) PollWorker.schedule(this)
    }
}

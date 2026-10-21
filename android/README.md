# Homing · Android 客户端

> 返回 [Homing 主文档](../README.md)

在手机上接收 Homing 的新消息提醒。界面直接嵌网页版，App 本身只负责弹通知。

## 工作方式

**定时拉取，不常驻。** WorkManager 每 15 分钟调一次 `/api/messages`，系统会把它和其它任务合并执行。

- 不常驻、没有前台服务，也不需要加电池白名单，基本不耗电
- 代价是提醒有延迟：通常在 15 分钟内，手机息屏较久（Doze）时系统会推迟到维护窗口，可能更晚
- 打开 App 时是网页版的 SSE，消息实时到达

没有用 FCM：那需要服务端能连上 Google，并且要接入 Firebase，和「自托管、零依赖」的目标不符。真要秒到，只能做前台服务保持 SSE 长连接，代价是通知栏常驻一条，还得加电池白名单。

**弹哪些消息**（[Poller.kt](app/src/main/java/io/github/homing/Poller.kt)）

- 只弹游标之后的消息。游标在登录时定为当时最新的 id，所以之前的消息不会补弹
- 已读的不弹。被 AI 判为垃圾的不弹（接口默认就不返回它们）
- AI 还在整理的（`ai_status=pending`）先不弹，等下一轮确认不是垃圾再弹。和服务端弹 macOS 通知的逻辑一致。超过 10 分钟还没整理完的不再等
- App 在前台时网页是实时的。切到后台时，把当时已有的消息都记为已读过，不会再弹一遍
- 网页上读过、删掉的、事后被判为垃圾的消息，下次拉取时撤掉对应通知

**通知样式**（[Notifier.kt](app/src/main/java/io/github/homing/Notifier.kt)）

| 渠道 | 内容 | 默认 |
|---|---|---|
| 重要 | `level=error` | 响铃 + 横幅 |
| 提醒 | `level=warning` | 响铃 + 横幅 |
| 聊天 | 有 `conv` 的消息，同一会话合并成一条聊天样式通知 | 响铃 + 横幅 |
| 普通 | 其它级别，包括自定义级别 | 响铃 |
| 应用状态 | 登录失效 | 响铃 |

- 响铃、横幅、免打扰例外，都在系统的渠道设置里按渠道调
- 标题和正文优先用 AI 整理过的版本。聊天消息用原文
- 通知颜色取自服务端的级别颜色
- 一轮里普通消息超过 10 条时，多出来的合并成一条「另有 N 条新消息」
- 点通知会打开 App，跳到对应的消息（`#/m/<id>`）。「已读」按钮调 `/api/read`

**登录**

- 用密码调 `/api/login`，拿到 `homing_session`，同时写进 WebView，网页不用再登录一次
- 密码存在应用私有目录里，不参与备份。会话 30 天过期，或者服务端改了密码时，用存的密码自动重新登录
- 密码也不对的话，弹一条「登录已失效」，直到重新登录

## 使用

1. 安装 APK，首次打开时填服务器地址（如 `https://homing.example.com`，局域网的 `http://<局域网 IP>:8790` 也可以）和登录密码
2. 允许通知权限
3. 设置页可以从桌面长按图标进入，也可以从系统的「通知设置 → 应用中的其他设置」进入。设置页里能看上次检查的时间和结果，也能手动立即检查

国产 ROM（MIUI、ColorOS 等）可能会限制后台任务。如果一直不来提醒，到系统设置里给这个 App 打开「自启动」，或者把省电策略设为「无限制」。

## 构建

需要 JDK 17+ 和 Android SDK（compileSdk 36）。

```bash
cd android
echo "sdk.dir=$ANDROID_HOME" > local.properties   # 首次
./gradlew assembleDebug                          # → app/build/outputs/apk/debug/app-debug.apk
```

正式包需要签名。在 `android/` 下放 `keystore.properties`（已在 .gitignore 里）：

```properties
storeFile=homing-release.jks
storePassword=…
keyAlias=homing
keyPassword=…
```

生成密钥（只需一次）：

```bash
keytool -genkeypair -v -keystore homing-release.jks -alias homing -keyalg RSA -keysize 4096 -validity 36500
```

然后 `./gradlew assembleRelease`，产物在 `app/build/outputs/apk/release/`。**密钥文件丢了，以后的新版本就没法覆盖安装**，只能卸载重装，记得备份。

依赖只有 AndroidX core / activity / work，HTTP 用系统自带的 `HttpURLConnection`，JSON 用 `org.json`。

## 服务端

不需要任何改动，用的都是网页版已有的接口：`/api/login`、`/api/messages`、`/api/levels`、`/api/read`。

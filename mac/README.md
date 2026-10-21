# Homing · macOS 转发客户端

> 返回 [Homing 主文档](../README.md)

把一台 Mac 上的**系统通知原样转发**到 Homing 服务端：飞书、微信、QQ、Telegram、邮件、日历……
凡是弹到 macOS 通知中心的，都会以原始记录的形式 POST 过去。

两个常见用法：

- **日常用的 Mac**：只装通知转发，手机、平板、其它电脑上也能看到这台 Mac 收到的通知
- **专用 Mac（「分机」）**：把吃内存的 IM 全挪到另一台 Mac 上无人值守地跑，通知转发到 Homing，
  需要回复时再用屏幕共享连上去。这种用法额外装一个「屏幕共享断开即锁屏」的服务

## 为什么会有「分机」这种用法

一台 32 GB 的 Mac 同时跑 Chrome、VS Code、两个飞书、微信、QQ、Telegram、Docker，内存长期见底：
压缩器吃掉 10 GB 以上，系统负载冲到 100+。最先崩的是要新建进程和窗口的操作，浏览器扩展弹窗
要等一分钟才出来，而 CPU 却显示 70% 空闲。这些 IM 合计占 6–7 GB，挪到另一台机器是治本的办法。
挪走之后还要能看到通知，这个客户端解决的就是这一环。

## 架构

```
┌───────────────────────────┐
│ 分机（无头运行、自动登录）     │
│ 飞书 / 微信 / QQ / …         │       HTTPS POST        ┌────────────────┐
│ notify_forward.py         │ ─────────────────────→  │                │
│ lock_on_disconnect.py     │  原始通知记录（JSON）      │  Homing 服务端  │
│   无人连接时关屏锁屏          │                         │  POST /notify  │
└───────────────────────────┘                         │                │
              ↑ 屏幕共享（需要回复消息时连上去）              │                │
┌───────────────────────────┐                         │                │
│ 日常使用的 Mac              │ ─────────────────────→  │                │
│ notify_forward.py         │                         └────────────────┘
└───────────────────────────┘
```

客户端对通知**不做任何筛选、提取或脱敏**，每条通知的完整记录都会发出去，建议走 HTTPS。
真实的地址和 token 写在 `config.py` 里，它已在 `.gitignore` 中排除。

两件需要在服务端或部署上考虑的事：

- **来源区分**：请求里不带机器标识。服务端按 app 归类，分不出同一个 app 的通知来自哪台 Mac
- **防循环**：如果某条通知又会回到这两台 Mac 上（比如在 Mac 的浏览器里开着 Homing 网页并允许了网页通知，
  或者 Homing 的消息被转发到飞书、而飞书也开在这台 Mac 上），这条推送本身又会产生一条系统通知，
  被转发回去，形成循环。客户端不做过滤，这种情况请关掉对应的网页通知，或在服务端收起该频道

## 目录

```
mac/
├── notify_forward.py     通知采集与转发
├── lock_on_disconnect.py 屏幕共享断开即锁屏（仅分机）
├── config.example.py     配置模板
├── install.sh            安装 / 卸载 LaunchAgent
└── docs/PITFALLS.md      9 条踩坑详录，改代码前先读
```

无第三方依赖，Python 3.9+ 标准库即可。

## 接口

`notify_forward.py` 对每条新通知发一次请求，请求体是 macOS 通知数据库 `record` 表里
这条通知的完整记录（binary plist 解码后转成 JSON）：

```
POST <RECEIVER>
Content-Type: application/json
X-Token: <TOKEN>

{
  "app": "com.tencent.qq",
  "uuid": "6EZG6ichSYa/0zE25lSYsQ==",
  "date": 811747258.0,
  "req": {"titl": "…", "subt": "…", "body": "…", "iden": "…", …},
  …
}
```

Homing 服务端的 `/notify` 已经处理好下面这些细节；如果你想自己写接收端，需要注意：

- 字段由 macOS 决定，客户端原样透传，不增不减。可以用 `python3 notify_forward.py --dump` 看实际结构
- 只有 JSON 表示不了的类型才做编码：`bytes` 转 base64，日期转 ISO 8601，`plistlib.UID` 转整数
- `date` 是 Apple 纪元秒（2001-01-01 起），转 Unix 时间加 978307200
- **`req.titl` / `req.body` 不一定是字符串**。App Store 等系统通知给的是待本地化的列表
  `[key, 格式, [参数...]]`，接收端必须能处理，否则会被一条消息打崩（PITFALLS 第 9 条）
- 返回 2xx 视为成功；其余情况（任何 HTTP 错误码、网络错误）进入重投队列，
  每 30 秒重投一轮，超过 1 小时仍失败则丢弃，队列上限 200 条。同一条通知可能被投递多次，
  接收端应按 `uuid` 去重

## 安装

下面按分机写。日常使用的 Mac 不需要第 1 步，第 5 步用不带参数的 `./install.sh`，其余相同。

### 1. 系统设置

（仅分机）系统设置 → 通用 → 共享，打开「远程登录」和「屏幕共享」。

（仅分机）系统设置 → 用户与群组 → **自动以此身份登录**。用户级 LaunchAgent 只在用户登录
后才加载，不开的话分机重启后会停在登录界面，服务不启动，而且没有任何报错。
开启后 macOS 会禁用这台机器上的 Apple Pay。

（仅分机）唤醒需要密码，否则「关屏」不等于「锁屏」：

```bash
defaults write com.apple.screensaver askForPassword -int 1
defaults write com.apple.screensaver askForPasswordDelay -int 0
```

### 2. 安装 Python 并锁版本

```bash
brew install python@3.14
brew pin python@3.14
```

要锁版本，是因为下一步授权的路径里带着版本号，`brew upgrade` 升级后授权随之失效，服务会静默停止。

### 3. 授予完全磁盘访问权限

客户端要读 `~/Library/Group Containers/group.com.apple.usernoted/db2/db`，
解释器需要「完全磁盘访问权限」（FDA）。这一步有两个反直觉的地方：

- **授权对象是 Python.app，不是 `bin/python3.14`**，后者在选择器里是灰色的。路径形如
  ```
  /opt/homebrew/Cellar/python@3.14/3.14.7/Frameworks/Python.framework/Versions/3.14/Resources/Python.app
  ```
- **它不会弹窗**，只能手动添加

打开设置面板，点 `+`，按 `Command+Shift+G` 粘贴上面的路径：

```bash
open "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"
```

授权后**完全退出终端（Command+Q）再重开**，然后验证：

```bash
python3 notify_forward.py --dump
```

能打印出通知结构就成功了。失败时它会告诉你应该授权哪个真实路径。

### 4. 配置

```bash
cd homing/mac          # 仓库里的 mac/ 目录
cp config.example.py config.py
chmod 600 config.py
```

| 项 | 说明 |
|---|---|
| `RECEIVER` | Homing 服务端的接收地址，形如 `https://homing.example.com/notify` |
| `TOKEN` | 服务端 `config.py` 里的 `TOKEN`，随请求头 `X-Token` 发送 |
| `POLL_SECONDS` | 轮询间隔，默认 2 秒 |

这台 Mac 上所有 app 的通知都会转发，包括系统通知。要筛选请在服务端做（比如收起不想看的 app 频道）。

Homing 网页的「接入 → macOS 转发」里可以直接复制填好地址的配置。

### 5. 安装服务

```bash
./install.sh --headless   # 分机
./install.sh              # 日常使用的 Mac
```

它会：

1. 逐个候选解释器实测能否读通知库，选出有权限的那个，并解析成 Python.app 内的
   真实二进制（写 `bin/python3.14` 这类 stub 路径，launchd 启动时拿不到权限）
2. 生成并加载通知转发的 LaunchAgent（`io.github.homing.forward`），开机自启、崩溃自动重拉
3. 加 `--headless` 时，再装锁屏服务（`io.github.homing.lock`），并检查唤醒密码和自动登录。
   **锁屏服务不要装在日常使用的机器上**，没人连屏幕共享时它每 60 秒关一次屏

读取测试是在当前 shell 里跑的，而 TCC 按发起进程归属权限，结果可能和 launchd
启动时不一致。确认已授权但测试仍不通过时，可以显式指定解释器跳过测试：

```bash
PYTHON=/opt/homebrew/bin/python3.14 ./install.sh
```

装好后看日志确认没有权限报错。

### 6. 验证

```bash
osascript -e 'display notification "测试" with title "部署验证"'
```

**至少等 25 秒**再看日志。通知写进数据库本身有约 10 秒延迟，这是 macOS 的行为，
调小轮询间隔也没用。

```bash
tail -3 /tmp/homing-forward.log
```

应该看到 `→ com.apple.ScriptEditor2`，Homing 侧栏「Mac 应用」下也会出现「脚本编辑器」。

## 日常运维

### 日志

```bash
tail -f /tmp/homing-forward.log   # 转发
tail -f /tmp/homing-lock.log      # 锁屏（仅分机）
```

| 标记 | 含义 |
|---|---|
| `→ <bundle id>` | 已送达 |
| `× <bundle id>（发送失败，稍后重投）` | 服务端返回非 2xx 或网络错误，已入重投队列 |
| `↻ 重投：成功 N，丢弃 N，待重投 N` | 每轮重投的汇总 |

日志只记 bundle id，不记消息内容。

### 更新代码

```bash
git pull && ./install.sh --headless   # 日常使用的 Mac 去掉 --headless
```

`config.py` 不入库，`git pull` 不会覆盖它。

### 重启服务 / 卸载

```bash
launchctl kickstart -k gui/$(id -u)/io.github.homing.forward
./install.sh uninstall
```

### 锁屏行为

只在分机上运行（`--headless` 安装）。`lock_on_disconnect.py` 每 2 秒检查一次屏幕共享连接状态：

- 启动时没有连接：立即关屏
- 屏幕共享断开：立即关屏
- 没有连接期间：每 60 秒再关一次兜底，压住系统零星的唤醒

配合唤醒密码，关屏就等于锁屏。它没有用 `CGSession -suspend` 那类会切到登录窗口的
命令，因为转发服务跑在用户会话里，没必要冒这个险。

屏幕共享连着的时候屏幕关不掉，`ScreensharingAgent` 会持续制造用户活动事件，
这是系统设计。屏幕是否真的灭了没法用程序检测，改动锁屏逻辑后要人眼确认一次。

## 已知限制

- **约 10 秒延迟**：来自 macOS 通知落库，无法消除
- **只有通知记录本身**：数据库里有什么就发什么。图片、卡片等富内容不在通知记录里，拿不到
- **只转发启动之后的通知**：服务重启期间到达、重启前已在通知中心里的，不会补发
- **通知数据库是私有格式**：Apple 不保证结构稳定，macOS 大版本升级后先用 `--dump` 核对字段
- **Python 升级会打断服务**：见安装第 2 步。确需升级，要重新授权 FDA，再跑 `./install.sh`

## 排障

| 现象 | 先查 | PITFALLS |
|---|---|---|
| `PermissionError` / 读不到数据库 | FDA 授权对象、plist 里的解释器路径 | 1、2 |
| `record` 表恒为 0 行 | 是否连 WAL 一起读 | 3 |
| 发了通知但没转发 | 是否等够 25 秒 | 4 |
| 进程在跑但日志空白 | 是否缺 `-u` | 5 |
| 分机重启后服务没起来 | 自动登录 | 6 |
| 开机后屏幕没灭 | 锁屏脚本的启动逻辑 | 7 |
| 某个 app 的通知从来不转发 | app 是否发过通知、是否登录 | 8 |
| 服务端持续失败、日志大量重投 | 是否有非字符串字段打崩了接收端 | 9 |

详见 [docs/PITFALLS.md](docs/PITFALLS.md)。

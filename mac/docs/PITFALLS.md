# 踩坑详录

这 9 条都是实际调试中撞出来的，没有一条能靠读文档或推理预先绕开。
**改动相关代码前请先读对应条目。**

大多数的共同特征是**失败是静默的**：没有报错、没有异常，只是「不工作」。
这类问题最耗时，所以每条都附了验证方法。

文中「分机」指无人值守、专门跑 IM 的那台 Mac；「远端」「接收端」指 Homing 服务端
（或任何实现了 `POST /notify` 的接收端）。部分条目提到的旧架构（分机上自带接收端、
按 app 白名单筛选）已经移除，保留下来是因为现象和排查思路仍然有参考价值。

---

## 1. FDA 要授权给 Python.app，不是 bin 里的 python

### 现象

在「完全磁盘访问权限」的文件选择器里，`bin/python3.x` 是**灰色不可选**的。

```
idle3          灰色
pip3           黑色，可选     ← 207 字节的脚本
pip3.14        灰色           ← 和 pip3 内容完全相同
python3        灰色           ← 符号链接
python3.14     灰色           ← 34640 字节的 Mach-O 可执行文件
```

`pip3` 和 `pip3.14` 是**一模一样的 207 字节脚本**，却一个能选一个不能，
所以置灰规律与符号链接、文件类型都无关，具体规则未查明。

### 解决

授权 framework 自带的 `.app`：

```
/opt/homebrew/Cellar/python@3.x/3.x.y/Frameworks/Python.framework/Versions/3.x/Resources/Python.app
```

对 framework 形式的 Python，TCC 归因本来就落在这个 app 上，这不是绕路，是正解。

### 另一个反直觉点

**FDA 不会弹窗请求。** 摄像头、麦克风、通讯录这类权限会弹窗让你点「允许」，
FDA 是例外：程序访问被拒时只静默收到 EPERM，只能手动添加。直接打开设置面板：

```bash
open "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"
```

### 验证

```bash
python3 notify_forward.py --dump
```

能打印出通知结构即授权成功；失败时会提示应授权的解释器真实路径。
授权后**必须完全退出终端（Command+Q）再重开**，TCC 变更对已运行进程不生效。

---

## 2. launchd 必须直接指向被授权的二进制

### 现象

同一份代码，SSH 里跑正常，launchd 启动就报错：

```
PermissionError: [Errno 1] Operation not permitted:
    '/Users/xxx/Library/Group Containers/group.com.apple.usernoted/db2/db'
```

### 原因

两处叠加：

- plist 里写 `/opt/homebrew/bin/python3.14` 时，launchd 启动的进程拿不到 FDA。
  那是个 stub，TCC 在 launchd 场景下的归因和 SSH 场景不同
- 用 PATH 里的 `python3` 去推导路径也会错：SSH 非交互会话的 PATH 不含
  `/opt/homebrew/bin`，会解析到系统自带的 Python 3.9，而 FDA 是按二进制授权的，
  授给 Homebrew Python 的权限它用不了。`install.sh` 最早就是这么装出了一个
  持续报错的服务

### 解决

`ProgramArguments` 直接写 Python.app 内的真实可执行文件：

```xml
<string>/opt/homebrew/Cellar/python@3.14/3.14.7/Frameworks/Python.framework/Versions/3.14/Resources/Python.app/Contents/MacOS/Python</string>
```

`install.sh` 的 `pick_python()` 会逐个候选解释器**实测能否读通知库**，
选通过的那个，再由 `app_binary()` 解析成 Python.app 内的路径。
可以用 `PYTHON=/path/to/python3 ./install.sh` 指定候选。

### 验证

```bash
ps -o command= -p $(pgrep -f notify_forward.py)
```

输出里应出现 `Python.app/Contents/MacOS/Python`，而不是 `bin/python3.x`。

---

## 3. 必须连 WAL 一起复制，否则永远读到 0 行

### 现象

通知明明弹出来了，`record` 表却始终是 0 行。权限正常、表结构正常、字段名也对。

### 原因

新通知先写进 `db-wal`（SQLite 的预写日志），用 `mode=ro` 直接打开原库
**读不到** WAL 里尚未合并的数据。

```
db        823296 字节   最后修改 21:05
db-wal    131872 字节   最后修改 22:21   ← 数据在这里
db-shm     32768 字节
```

### 解决

把 `db` / `db-wal` / `db-shm` 一起复制到临时目录，以读写模式打开副本，
WAL 会被正确重放，也不干扰系统写入。见 `notify_forward.py` 的 `read_records()`。

### 附带：记录结构

`delivered` 和 `displayed` 两张表的 `list` 字段全是 NULL，只是索引表。
通知内容在 `record` 表的 `data` 列，是 binary plist：

```json
{
  "app": "com.tencent.qq",
  "date": 811747258.0,
  "uuid": "...",
  "req": { "titl": "标题", "subt": "副标题", "body": "正文" }
}
```

- `date` 是 Apple 纪元秒（2001-01-01 起），转 Unix 时间加 978307200
- `titl` / `body` **不一定是字符串**，见第 9 条
- `record` 表只保存通知中心里**尚未清除**的通知，看过或清掉就从表里消失

---

## 4. 通知落库有约 10 秒延迟

### 现象

发了通知，立刻查数据库读不到，几秒后再查又有了。

### 实测

```
+ 2s  record 行数=7
+ 4s  record 行数=7
+ 6s  record 行数=7
+ 8s  record 行数=7
+10s  record 行数=8  ★ 读到了
```

### 影响

**这是 macOS 自身的行为，无法消除。** 把 `POLL_SECONDS` 调到 1 秒也不会更快，
数据根本还没落盘。

调试时**至少等 25 秒**再判断成败。排查阶段有三次测试只等了 6~10 秒，
每次都卡在这个边界上，误判成「读不到通知」，白白往权限和逻辑方向查了很久。

---

## 5. 后台运行必须加 `-u`

### 现象

进程明明在跑（`pgrep` 找得到），日志文件却是空的，看起来像没启动。

### 原因

Python 后台运行时 stdout 不是 tty，走块缓冲，输出卡在内存里不落盘。
`> logfile` 重定向又会先把文件截断，于是 `cat` 看到的是空文件。

### 解决

plist 的 `ProgramArguments` 里加 `-u`（`install.sh` 已处理），手动跑时也要加：

```bash
python3 -u notify_forward.py > /tmp/x.log 2>&1 &
```

**看到日志为空时，先确认不是缓冲问题。**

---

## 6. launchd 进程一度连不上局域网

### 现象

launchd 启动的进程**只能连公网，连不了局域网**，同一个二进制在 SSH 里一切正常：

```
launchd 启动:
  ❌ 192.168.1.100:8788    No route to host     ← 局域网
  ❌ 192.168.1.101:8788    No route to host     ← 局域网（另一网段）
  ✅ 223.5.5.5:53          成功                 ← 公网
  ✅ 114.114.114.114:53    成功                 ← 公网
```

路由如果真坏了公网也该不通，所以不是路由问题。

### 结论只到这一步

用屏幕共享连上分机之后，问题自己消失了，断开屏幕共享后也没有复发。
整个过程中 `who` 显示 console 会话**一直存在**，所以早期文档里
「依赖 console 会话」的说法**没有被证实**。更可能的解释是 macOS 的
「本地网络」隐私权限在某次 GUI 交互中被授予了，但同样没有确证。

### 现状

现在的架构只向公网 HTTPS 地址发送，而上面的实测里 launchd 进程访问公网
一直正常，这个坑已经绕开了。**如果以后再加局域网内的接收端，务必在 launchd
下实测一次连通性**，不要只在 SSH 里测。

### 仍然成立的部分

**分机必须开启自动登录**（系统设置 → 用户与群组 → 自动以此身份登录）。
用户级 LaunchAgent 跟随用户登录才加载，分机重启后若停在登录界面，服务根本不启动，
而且没有任何报错。

副作用：开启自动登录后 macOS 会**禁用该机器上的 Apple Pay**，系统会发通知告知。

---

## 7. 只处理状态转换会漏掉初始状态

### 现象

「屏幕共享断开即锁屏」的脚本，开机后一次都没触发过。

```
00:36:29  监控启动，当前屏幕共享: 未连接
（之后再无输出）
```

### 原因

```python
prev = sharing_connected()      # 开机时 = False
while True:
    now = sharing_connected()
    if prev and not now:        # 永远不成立
        lock()
```

开机后从来没人连过屏幕共享，「从已连接变断开」这个事件**永远不会发生**。
只写了状态*转换*的处理，漏掉了*初始状态就该动作*的情况。

### 解决

三种触发时机缺一不可：

| 时机 | 说明 |
|---|---|
| 启动时无连接 | 立即锁屏 |
| 屏幕共享断开 | 事件触发 |
| 每 60 秒兜底 | 无连接期间周期性关屏 |

### 为什么纯事件驱动不够

开机时内置键盘/触控板和 powerd 会各建立一个 `UserIsActive` 断言，
**超时长达约 113 分钟**：

```
WindowServer: UserIsActive "...Apple Internal Keyboard / Trackpad"  剩 6571 秒
powerd:       UserIsActive "com.apple.powerd.ws.initialize"          剩 6549 秒
```

而 `displaysleep` 默认 120 分钟，两者叠加，屏幕能亮近两小时。
系统事件（唤醒、外设插拔、定时任务）也会零星点亮屏幕，必须周期性兜底。

### 屏幕状态无法程序化检测

以下方法在 macOS 27 上**全部失效**：

```bash
ioreg -c IODisplayWrangler -k IOPowerManagement      # 无输出
ioreg -n IODisplayWrangler -r                        # 无输出
pmset -g powerstate IODisplayWrangler                # Internal failure
```

所以脚本只能确保命令执行，无法自检屏幕是否真的灭了。**改动这块后需人眼确认一次。**

---

## 8. bundle id 大小写在系统各处不一致

### 现象

白名单里写了飞书和微信，但它们的通知从来不转发，且**没有任何报错**。

### 原因

同一个 app 的 bundle id，在系统不同地方大小写不同：

| 来源 | 值 |
|---|---|
| 通知数据库 `app` 表 | `com.larksuite.larkapp`（全小写） |
| 通知记录的 plist | `com.larksuite.larkApp`（驼峰） |
| 通知设置 ncprefs | `com.tencent.xinWeChat`（驼峰） |
| 通知数据库 `app` 表 | `com.tencent.xinwechat`（全小写） |

凭印象猜的值还往往整个是错的：

```
猜测                        实际
com.electron.lark      →   com.larksuite.larkApp
com.tencent.xinWeChat  →   com.tencent.xinwechat
```

### 现状

分机已不做 app 筛选，全部原样转发，这个坑在分机侧不存在了。
**远端如果要按 bundle id 筛选或归类，务必大小写不敏感地比较**，
并用实测值：`osascript -e 'id of app "微信"'`，或直接看转发日志。

### 附带：app 没发过通知就查不到它

某个 app 如果从未向通知中心发过通知，它**不会出现在任何地方**：

```
通知数据库 app 表 (97 项)  → 没有 com.tencent.qq
通知设置 ncprefs (68 项)   → 没有 com.tencent.qq
```

macOS 上 app 只有在**首次尝试发通知**时才注册并申请权限。所以查不到某个 app
不代表配置有问题，可能只是它还没发过通知，或者根本没登录。

这类权限请求**会弹窗**（与 FDA 不同），但无头机器上没人点，通知就永远不会到达。
需要连屏幕共享，人在屏幕前触发一次。

---

## 9. 通知字段可能是列表，一条就能让转发全面中断

### 现象

两个接收端在同一时刻、以完全相同的次数失败，远端返回 502，本机接收端
直接断开连接：

```
[warn] http://…:8788/notify 发送失败: Remote end closed connection without response
[error] https://…/notify 拒绝 HTTP 502
（两者各 36438 次，补发成功 0 次）
```

两个完全不同的服务不会恰好同时宕机，这是同一条消息让两边都崩了。

### 原因

一条 App Store 的系统通知，`titl` 和 `body` 不是字符串，而是待本地化的列表：

```
titl: list 长度3  元素类型=['str', 'str', 'list']     # [key, 格式, [参数...]]
body: list 长度3  元素类型=['str', 'str', 'list']
```

系统显示时才本地化成文字。原样透传后，接收端写库时崩溃：

```
sqlite3.ProgrammingError: Error binding parameter 3: type 'list' is not supported
```

更糟的是旧的重投逻辑：这条消息卡在队列里每 2 秒重试一次，不设上限，
把两边各打崩了三万多次，日志也被刷爆，真正的新通知反而淹没在里面。

### 解决

- 重投设了上限：每 30 秒重投一轮，超过 1 小时放弃，队列最多 200 条，
  每轮只记一行汇总日志。一条毒消息最多折腾一小时，也不会刷爆日志
- 分机现在原样转发、不改字段（曾有一版把字段拍平成文本，后来按需求去掉了），
  所以**这类字段一定会到达远端，远端必须能处理列表类型**，不能假设是字符串

### 验证

```bash
python3 notify_forward.py --dump
```

看 `req` 下的字段类型，远端的解析逻辑要覆盖到。

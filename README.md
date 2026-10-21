# Homing · 归巢

**中文** | [English](README.en.md)

自托管的个人通知收件箱。短信、快递、账单、CI 结果、服务器告警、脚本跑完的提醒、Mac 上的 IM 消息……
不管从哪儿发出来，都像信鸽归巢一样飞回同一个地方。

- **零依赖**：服务端只用 Python 3.9+ 标准库，一个进程、一个 SQLite 文件，`python3 server.py` 就能跑
- **什么都能接**：GitHub、GitLab、Alertmanager、Grafana、飞书、钉钉、企业微信、Slack、Discord 的 webhook
  直接填地址就能识别；任意 JSON、纯文本、GET 链接也行
- **实时**：网页通过 SSE 实时推送，可开浏览器通知；附带 Android 客户端和 macOS 通知转发客户端
- **可选 AI 整理**：接任意 OpenAI 兼容接口（包括本地模型），自动过滤广告、生成摘要、打标签

## 为什么做这个

推送散落在各处：短信里有验证码和快递，邮箱里有账单，飞书群里有机器人告警，GitHub 发邮件说 CI 挂了，
自己写的脚本跑完了不知道该通知到哪。每个渠道都要单独去看，重要的消息很容易淹没。

Homing 的思路很简单：给每个来源一个 webhook 地址，所有消息落到同一个收件箱里，统一分类、搜索、提醒。

一个具体的例子：一台 32 GB 的 Mac 同时开着两个飞书、微信、QQ、Telegram，内存长期见底。
把这些 IM 挪到另一台专用 Mac 上无人值守地跑，再用仓库里的 [macOS 转发客户端](mac/README.md)
把那台机器的系统通知原样转发到 Homing，主力机上就不用开任何 IM，也不会漏消息。

## 快速开始

### 本机运行

```bash
git clone https://github.com/Shirakiina/homing.git && cd homing
cp config.example.py config.py      # 至少设置 PASSWORD（登录用）和 TOKEN（推送用）
python3 server.py
```

打开 <http://127.0.0.1:8790/>，输入密码登录。点左下角「接入」可以直接复制各平台填好地址和 token 的配置，
「发送测试」会推一条测试消息。

在 Mac 上想开机自启：

```bash
./install.sh             # 注册为 launchd 服务，崩溃自动拉起；日志在 /tmp/homing.log
./install.sh uninstall   # 卸载
```

### Docker

```bash
cp .env.example .env     # 填 HOMING_PASSWORD 和 HOMING_TOKEN
docker compose up -d --build
```

同样打开 <http://localhost:8790/>。数据在 Docker 卷 `homing-data` 里。

> `PASSWORD` 或 `TOKEN` 没设置、或者还是 `change-me` 时，服务拒绝启动。

## 推送消息

```bash
curl -X POST 'http://127.0.0.1:8790/hook/deploy?token=<TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{"title":"部署完成","body":"**v1.4.2** 已上线","level":"success","url":"https://example.com/release/1.4.2"}'
```

- **频道**就是 `/hook/` 后面那一段，随便起，侧栏按它分组。加 `?name=` 可以指定显示名
- **token** 三种带法任选：`?token=`、`X-Token` 头、`Authorization: Bearer`
- 字段都可选：`title`、`body`（支持 Markdown）、`level`、`url`、`tags`（数组或逗号分隔字符串）
- **level**：填级别的名称或别名（见下方「级别」），认不出的归入「普通」
- **纯文本**也行：首行当标题，其余当正文
  ```bash
  printf '信用卡还款提醒\n本期账单 ¥1,280，28 日到期' | curl --data-binary @- 'http://127.0.0.1:8790/hook/bank?token=<TOKEN>'
  ```
- **只能发 GET 的地方**（iOS 快捷指令、浏览器书签、IFTTT）：
  `/hook/<频道>?token=…&title=…&body=…&level=…`。query 里的 `title` / `body` / `level` / `url` 会覆盖请求体里的同名字段
- 成功返回 `{"ok": true, "id": <消息 id>}`

### 自动识别的格式

把下面这些服务的 webhook 地址直接填成 `/hook/<频道>?token=…` 即可，不用改任何东西：

| 来源 | 识别方式 |
|---|---|
| GitHub | `X-GitHub-Event` 头；push、PR、issue、Actions、release 会整理成可读标题 |
| GitLab | `X-Gitlab-Event` 头；Pipeline 失败标为「重要」 |
| Prometheus Alertmanager / Grafana | `alerts` 数组；firing → 重要，resolved → 完成 |
| 飞书 / Lark 机器人 | `msg_type`（text / post / interactive 卡片） |
| 钉钉 / 企业微信机器人 | `msgtype`（text / markdown / link / actionCard） |
| Slack / Discord | `blocks` / `attachments` / `embeds` |
| 其它 JSON | 猜 `title` / `subject` / `message` / `content` / `text` / `from` 等常见字段；实在认不出就把 JSON 原样展示 |

已有脚本在往 IM 机器人发消息？把机器人的 webhook 地址换成 Homing 的就行，消息体不用改。
每条消息都保留原始请求体，详情页底部可以展开查看。

### 短信

- **iPhone**：快捷指令 → 自动化 →「信息」触发 →「获取 URL 内容」，POST JSON：`{"from": 发件人, "content": 内容}`
- **Android**：SmsForwarder 之类的短信转发 app，通道选 Webhook，模板 `{"from":"[from]","content":"[content]"}`

发件人作标题、内容作正文。网页「接入 → 短信」里有带好地址的完整步骤。

## 级别

级别用来给消息分类（左侧色点、筛选栏），点筛选栏右侧的 ✎ 编辑：

- 名称、颜色、别名都能改，可以拖动排序，也可以新增（如「快递」「账单」「验证码」）
- 推送时 `level` 填**名称或任一别名**即归入该级别，大小写不敏感
- 内置四个级别（默认名：重要 / 提醒 / 完成 / 普通）可改名改色但不能删。
  GitHub、告警等自动识别的来源按它们归类
- 没匹配上的、以及被删除的级别下的消息，都归入「普通」
- 单条消息的级别可以在详情页点级别标签修改

## AI 整理（可选）

设置 `AI_URL`（任意 OpenAI 兼容接口，到 `/v1` 为止，比如本地的 Ollama、vLLM、SGLang，或者云端服务）后，
每条新消息会在后台交给模型：

- **过滤**：广告、营销、骚扰移到侧栏「已过滤」，**不删除**；判错了在详情里点「不是垃圾」恢复，或点 ⊘ 手动标为垃圾
- **整理**：生成简洁标题和一句话摘要（保留金额、取件码等关键信息）；聊天和很短的消息不改写，原文始终完整保留
- **标签**：自动打 1–3 个内容标签，优先复用已有标签；侧栏「标签」可以按标签查看
- **级别**：只给没指定级别的消息选级别；推送时明确给了 `level`、或者你手动改过的，AI 不动

消息先入库、先显示，AI 整理完再原地更新。AI 不可用时消息照常到达：先连试 3 次，
仍失败的在 24 小时内每半小时自动再试一轮，服务恢复后自己补上（不会重复弹通知）。
左下角 ✦ 可以开关 AI、填写补充规则（如「外卖优惠券都算垃圾」）；详情页 ✦ 可以对单条重新整理。

> **隐私提示**：开启后，消息正文会发送到 `AI_URL`。短信验证码、银行动账这类内容建议只交给你自己部署的模型。

## 界面

- 三栏：来源 / 消息流 / 详情；窄屏自动折叠，手机上可以「添加到主屏幕」当 PWA 用
- 搜索、按级别筛选、星标、标记未读、修改级别、按频道或全部清空
- 聊天类 app（微信、QQ、Telegram、WhatsApp、飞书等）的 Mac 通知按联系人 / 群合并成会话
- **收起频道**：在频道视图点工具栏的 🔔，或者在侧栏频道上右键 / 长按。收起后该频道不出现在「全部 / 未读 / 标签」里、
  不计入未读数、不弹任何通知（包括 Android 客户端），移到侧栏底部的「已收起」分组，点进去、搜索、星标照常可用
- 键盘：`J` `K` 上下，`S` 星标，`U` 未读，`⌫` 删除，`O` 打开链接，`/` 搜索
- 亮 / 暗主题跟随系统，可以手动切换；标签页标题显示未读数
- 可以开启浏览器通知（页面不在前台时弹出）；服务端跑在 Mac 上时，也可以在 `config.py` 里打开 `SYSTEM_NOTIFY`
  用 macOS 原生通知（装了 `terminal-notifier` 时点通知能直接跳到这条消息）

## 客户端

| 客户端 | 说明 |
|---|---|
| [Android](android/README.md) | 嵌网页版界面，每 15 分钟拉一次新消息并弹手机通知。不常驻后台、几乎不耗电，代价是提醒有延迟。需要自己用 Android SDK 构建 |
| [macOS 转发](mac/README.md) | 读取 Mac 的系统通知数据库，把每条通知原样转发到 Homing 的 `/notify`。适合把 IM 挪到专用 Mac 上跑，或者在别的设备上看到这台 Mac 的通知 |

两个客户端都不需要服务端做任何额外配置。

## 部署到服务器

1. 用 Docker 跑起来（见「快速开始」）。放在反向代理后面时，把 `docker-compose.yaml` 里的端口改成 `127.0.0.1:8790:8790`
2. 反向代理参考 [deploy/nginx.conf.example](deploy/nginx.conf.example)。**`/api/stream` 是 SSE 长连接，必须关闭代理缓冲**，
   否则消息会卡在代理里，网页收不到实时更新
3. 在 `.env` 里设置：
   - `HOMING_PUBLIC_URL=https://你的域名`：「接入」面板会用它生成 webhook 地址
   - `HOMING_TRUST_PROXY=1`：代理设置了 `X-Real-IP` 时打开，登录防爆破才能按真实 IP 计数。**不在代理后面时不要开**，否则 IP 可以伪造
4. GitHub、Grafana 这类云服务要能访问到你的服务器才推得进来；只在内网用的话，可以配合 Tailscale、WireGuard 或内网穿透

`GET /health` 是健康检查接口，不需要登录。

## 配置项

所有配置都在 `config.py` 里（模板见 [config.example.py](config.example.py)），每一项都可以用环境变量 `HOMING_<名字>` 覆盖，
Docker 部署就是走环境变量。

| 配置 | 默认 | 说明 |
|---|---|---|
| `HOST` / `PORT` | `0.0.0.0` / `8790` | 监听地址和端口 |
| `PASSWORD` | 必填 | 登录密码。改密码会让所有已登录的设备立即下线 |
| `TOKEN` | 必填 | 推送 token，所有写入接口（`/hook/*`、`/notify`）都要带。生成：`openssl rand -hex 16` |
| `PUBLIC_URL` | 空 | 对外访问地址，用于「接入」面板生成地址 |
| `TRUST_PROXY` | `0` | 是否信任反向代理传来的 `X-Real-IP` |
| `SESSION_DAYS` | `30` | 登录有效期（天） |
| `DB_PATH` | `~/.homing.db` | 数据库位置（Docker 里是 `/data/homing.db`） |
| `KEEP_DAYS` | `30` | 消息保留天数，星标消息不清理 |
| `SYSTEM_NOTIFY` | `0` | 收到消息时弹 macOS 系统通知（仅服务端跑在 Mac 上时有效） |
| `AI_URL` | 空 | OpenAI 兼容接口地址，到 `/v1` 为止。留空即关闭 AI 整理 |
| `AI_MODEL` | 空 | 留空则取接口返回的第一个模型 |
| `AI_KEY` | 空 | 接口需要鉴权时填写 |
| `AI_TIMEOUT` | `30` | 单次调用超时（秒） |

## 安全

两套凭据，互不相干：

| | 用途 | 配置项 |
|---|---|---|
| 登录密码 | 打开界面查看消息 | `PASSWORD` |
| 推送 token | 往里写消息 | `TOKEN` |

- 登录只需密码，会话默认 30 天有效，服务重启不掉线；「退出登录」只清除当前浏览器，改密码则所有设备下线
- 防爆破：同一 IP 15 分钟内错 5 次锁定 15 分钟；全局错 30 次也会锁定（防止伪造 IP 绕过）
- Cookie：HttpOnly + SameSite=Lax，HTTPS 下自动加 Secure；管理 API 只接受 JSON，防止跨站调用
- **公网部署请务必走 HTTPS**：token 常常放在 URL 里，明文传输等于公开
- token 泄露的后果是别人能往你的收件箱里塞消息（看不到消息）；改 `TOKEN` 后记得同步更新各处 webhook
- 开启 AI 整理后消息正文会发给模型；macOS 转发客户端会发送每条通知的完整内容。请按自己的隐私要求选择部署位置

## 数据

- SQLite 单文件，默认 `~/.homing.db`（WAL 模式），保留 30 天，星标消息不清理
- 本机用 `install.sh` 安装时，日志在 `/tmp/homing.log`
- Docker 部署的备份：
  ```bash
  docker compose exec homing python -c "import sqlite3; sqlite3.connect('/data/homing.db').backup(sqlite3.connect('/data/backup.db'))"
  docker compose cp homing:/data/backup.db ./homing-backup.db
  ```

## 目录结构

```
server.py            HTTP 服务、存储、SSE、登录鉴权
adapters.py          各种 webhook 格式 → 统一消息结构
ai.py                AI 整理（OpenAI 兼容接口）
config.example.py    配置模板
static/              网页界面（原生 JS，无构建步骤）
install.sh           macOS launchd 安装脚本
Dockerfile, docker-compose.yaml, .env.example
deploy/              反向代理示例
android/             Android 客户端（Kotlin）
mac/                 macOS 通知转发客户端
```

## License

[MIT](LICENSE)

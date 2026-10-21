# Homing

[中文](README.md) | **English**

A self-hosted personal notification inbox. SMS, parcel updates, bills, CI results, server alerts,
"your script finished" pings, IM messages from your Mac… wherever they come from, they all fly home
to one place, like homing pigeons.

- **Zero dependencies**: the server uses only the Python 3.9+ standard library. One process, one SQLite file — `python3 server.py` and you're running
- **Accepts almost anything**: webhooks from GitHub, GitLab, Alertmanager, Grafana, Feishu/Lark, DingTalk, WeCom, Slack and Discord
  are recognized as-is; arbitrary JSON, plain text and GET links work too
- **Real-time**: the web UI updates over SSE and can show browser notifications; comes with an Android client and a macOS notification forwarder
- **Optional AI triage**: plug in any OpenAI-compatible endpoint (local models included) to filter ads, summarize and tag messages

> The web UI and the Android app are currently in Chinese only.

## Why

Notifications are scattered everywhere: verification codes and parcel updates in SMS, bills in email,
bot alerts in group chats, CI failures in GitHub emails, and your own scripts have nowhere good to report to.
Every channel has to be checked separately, and important messages get buried.

Homing keeps it simple: give each source a webhook URL, and land everything in one inbox where it can be
categorized, searched and alerted on.

A concrete example: a 32 GB Mac running two Feishu instances, WeChat, QQ and Telegram at the same time is
constantly out of memory. Move those IM apps to a dedicated, unattended Mac, and use the
[macOS forwarder](mac/README.md) in this repo to forward that machine's system notifications to Homing.
Your main machine no longer runs any IM app, and you don't miss a message.

## Quick start

### Run locally

```bash
git clone https://github.com/Shirakiina/homing.git && cd homing
cp config.example.py config.py      # set at least PASSWORD (for login) and TOKEN (for pushing)
python3 server.py
```

Open <http://127.0.0.1:8790/> and log in with the password. The "接入" (Connect) button at the bottom left
gives you ready-to-copy configs for each platform, with your URL and token filled in. "发送测试" sends a test message.

To start it at login on a Mac:

```bash
./install.sh             # registers a launchd service that restarts on crash; logs in /tmp/homing.log
./install.sh uninstall   # remove it
```

### Docker

```bash
cp .env.example .env     # fill in HOMING_PASSWORD and HOMING_TOKEN
docker compose up -d --build
```

Then open <http://localhost:8790/>. Data lives in the `homing-data` Docker volume.

> The server refuses to start if `PASSWORD` or `TOKEN` is unset or still `change-me`.

## Pushing messages

```bash
curl -X POST 'http://127.0.0.1:8790/hook/deploy?token=<TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{"title":"Deployed","body":"**v1.4.2** is live","level":"success","url":"https://example.com/release/1.4.2"}'
```

- The **channel** is the path segment after `/hook/` — name it whatever you like; the sidebar groups by it. Add `?name=` to set a display name
- Pass the **token** any of three ways: `?token=`, an `X-Token` header, or `Authorization: Bearer`
- All fields are optional: `title`, `body` (Markdown supported), `level`, `url`, `tags` (array or comma-separated string)
- **level**: a level's name or one of its aliases (see "Levels" below); anything unrecognized falls back to the default level
- **Plain text** works too: the first line becomes the title, the rest the body
  ```bash
  printf 'Credit card due\nStatement balance $1,280, due on the 28th' | curl --data-binary @- 'http://127.0.0.1:8790/hook/bank?token=<TOKEN>'
  ```
- **GET-only callers** (iOS Shortcuts, bookmarks, IFTTT):
  `/hook/<channel>?token=…&title=…&body=…&level=…`. Query parameters `title` / `body` / `level` / `url` override fields in the request body
- On success it returns `{"ok": true, "id": <message id>}`

### Recognized formats

Just point these services' webhooks at `/hook/<channel>?token=…` — no changes needed:

| Source | Detected by |
|---|---|
| GitHub | `X-GitHub-Event` header; push, PR, issue, Actions and release events get readable titles |
| GitLab | `X-Gitlab-Event` header; failed pipelines are marked as important |
| Prometheus Alertmanager / Grafana | `alerts` array; firing → important, resolved → done |
| Feishu / Lark bots | `msg_type` (text / post / interactive cards) |
| DingTalk / WeCom bots | `msgtype` (text / markdown / link / actionCard) |
| Slack / Discord | `blocks` / `attachments` / `embeds` |
| Any other JSON | guesses common fields such as `title` / `subject` / `message` / `content` / `text` / `from`; if nothing matches, the JSON is shown as-is |

Already have scripts posting to a chat bot? Swap the bot's webhook URL for Homing's — the payload stays the same.
Every message keeps its raw request body, viewable at the bottom of the detail pane.

### SMS

- **iPhone**: Shortcuts → Automation → "Message" trigger → "Get Contents of URL", POST JSON: `{"from": Sender, "content": Content}`
- **Android**: an SMS forwarding app such as SmsForwarder, Webhook channel, template `{"from":"[from]","content":"[content]"}`

The sender becomes the title and the text the body. The web UI's "接入 → 短信" tab has step-by-step instructions with your URL filled in.

## Levels

Levels categorize messages (the colored dot on the left, the filter bar). Edit them with ✎ at the right of the filter bar:

- Rename, recolor, add aliases, drag to reorder, or add new ones (e.g. "Parcels", "Bills", "Codes")
- When pushing, set `level` to **a level's name or any of its aliases** (case-insensitive)
- The four built-in levels (default names: 重要 important / 提醒 warning / 完成 done / 普通 normal) can be renamed and recolored but not deleted.
  Auto-detected sources such as GitHub and alerts map onto them
- Unmatched messages, and messages under a deleted level, fall back to "normal"
- A single message's level can be changed by clicking its level tag in the detail pane

## AI triage (optional)

Set `AI_URL` (any OpenAI-compatible endpoint, up to `/v1` — local Ollama, vLLM, SGLang, or a cloud service)
and each new message is handed to the model in the background:

- **Filtering**: ads, marketing and spam move to the "已过滤" (filtered) section in the sidebar — **never deleted**. Click "不是垃圾" (not spam) to restore a false positive, or ⊘ to mark spam by hand
- **Summaries**: a concise title and a one-line summary that keeps key details like amounts and pickup codes; chats and very short messages are left alone, and the original text is always kept
- **Tags**: 1–3 content tags, reusing existing tags when possible; browse by tag in the sidebar
- **Levels**: only for messages pushed without a level; levels set at push time or changed by you are never touched

Messages are stored and shown immediately; the AI result updates them in place. If the model is unavailable,
messages still arrive: each is tried 3 times, and failures are retried every 30 minutes for 24 hours,
so everything catches up once the model is back (without duplicate notifications).
The ✦ button at the bottom left toggles AI and accepts extra rules (e.g. "food delivery coupons are spam");
✦ in the detail pane reprocesses a single message.

> **Privacy**: with AI enabled, message bodies are sent to `AI_URL`. For things like SMS verification codes and bank alerts,
> consider using a model you host yourself.

## Web UI

- Three panes: sources / message list / detail; collapses on narrow screens, and can be added to a phone's home screen as a PWA
- Search, filter by level, star, mark unread, change level, clear a channel or everything
- Mac notifications from chat apps (WeChat, QQ, Telegram, WhatsApp, Feishu, …) are grouped into conversations per contact or group
- **Collapse a channel**: click 🔔 in the toolbar of a channel view, or right-click / long-press the channel in the sidebar. A collapsed channel
  is hidden from "All / Unread / Tags", excluded from unread counts and never notifies (Android client included); it moves to a "已收起"
  (collapsed) group at the bottom of the sidebar, where browsing, search and starring still work
- Keyboard: `J` `K` move, `S` star, `U` unread, `⌫` delete, `O` open link, `/` search
- Light / dark theme follows the system and can be toggled; the tab title shows the unread count
- Browser notifications can be enabled (shown when the page is in the background). When the server runs on a Mac you can also turn on
  `SYSTEM_NOTIFY` in `config.py` for native macOS notifications (with `terminal-notifier` installed, clicking one opens that message)

## Clients

| Client | Description |
|---|---|
| [Android](android/README.md) | Wraps the web UI and polls for new messages every 15 minutes to post phone notifications. No persistent background service and almost no battery cost, at the price of some delay. Build it yourself with the Android SDK |
| [macOS forwarder](mac/README.md) | Reads the Mac's notification database and forwards every notification as-is to Homing's `/notify`. Useful for running IM apps on a dedicated Mac, or seeing one Mac's notifications on other devices |

Neither client needs any extra server-side configuration. (Their docs are in Chinese.)

## Deploying to a server

1. Run it with Docker (see "Quick start"). Behind a reverse proxy, change the port in `docker-compose.yaml` to `127.0.0.1:8790:8790`
2. See [deploy/nginx.conf.example](deploy/nginx.conf.example) for the reverse proxy. **`/api/stream` is a long-lived SSE connection — proxy buffering must be off**,
   otherwise messages get stuck in the proxy and the web UI stops updating in real time
3. In `.env`, set:
   - `HOMING_PUBLIC_URL=https://your.domain` — used by the Connect panel to build webhook URLs
   - `HOMING_TRUST_PROXY=1` — when the proxy sets `X-Real-IP`, so login rate limiting counts real client IPs. **Leave it off when not behind a proxy**, or IPs can be spoofed
4. Cloud services like GitHub or Grafana must be able to reach your server to push. For LAN-only setups, pair it with Tailscale, WireGuard or a tunnel

`GET /health` is a health check endpoint that requires no login.

## Configuration

Everything lives in `config.py` (template: [config.example.py](config.example.py)). Every option can be overridden with an
environment variable `HOMING_<NAME>` — that's how the Docker setup is configured.

| Option | Default | Description |
|---|---|---|
| `HOST` / `PORT` | `0.0.0.0` / `8790` | Listen address and port |
| `PASSWORD` | required | Login password. Changing it logs out every device immediately |
| `TOKEN` | required | Push token, required by all write endpoints (`/hook/*`, `/notify`). Generate with `openssl rand -hex 16` |
| `PUBLIC_URL` | empty | Public URL, used by the Connect panel |
| `TRUST_PROXY` | `0` | Trust `X-Real-IP` from a reverse proxy |
| `SESSION_DAYS` | `30` | Login session lifetime in days |
| `DB_PATH` | `~/.homing.db` | Database location (`/data/homing.db` in Docker) |
| `KEEP_DAYS` | `30` | Days to keep messages; starred messages are never purged |
| `SYSTEM_NOTIFY` | `0` | Show native macOS notifications for new messages (only when the server runs on a Mac) |
| `AI_URL` | empty | OpenAI-compatible endpoint up to `/v1`. Empty disables AI triage |
| `AI_MODEL` | empty | Defaults to the first model the endpoint lists |
| `AI_KEY` | empty | API key, if the endpoint needs one |
| `AI_TIMEOUT` | `30` | Per-request timeout in seconds |

## Security

Two independent credentials:

| | Used for | Option |
|---|---|---|
| Login password | Opening the UI and reading messages | `PASSWORD` |
| Push token | Writing messages | `TOKEN` |

- Login takes only the password; sessions last 30 days by default and survive server restarts. "Log out" clears only the current browser; changing the password logs out every device
- Brute-force protection: 5 failures from one IP within 15 minutes locks that IP for 15 minutes; 30 failures globally also triggers a lock (so spoofed IPs can't get around it)
- Cookies are HttpOnly + SameSite=Lax, with Secure added automatically over HTTPS; the management API only accepts JSON, preventing cross-site calls
- **Always use HTTPS on the public internet**: the token often sits in URLs, and plaintext means it's public
- A leaked token lets someone push messages into your inbox (it does not let them read anything); after changing `TOKEN`, update your webhooks
- With AI triage on, message bodies go to the model; the macOS forwarder sends the full content of every notification. Choose where you deploy accordingly

## Data

- A single SQLite file, `~/.homing.db` by default (WAL mode), kept for 30 days; starred messages are never purged
- When installed locally via `install.sh`, logs go to `/tmp/homing.log`
- Backing up a Docker deployment:
  ```bash
  docker compose exec homing python -c "import sqlite3; sqlite3.connect('/data/homing.db').backup(sqlite3.connect('/data/backup.db'))"
  docker compose cp homing:/data/backup.db ./homing-backup.db
  ```

## Layout

```
server.py            HTTP server, storage, SSE, auth
adapters.py          webhook formats → one message shape
ai.py                AI triage (OpenAI-compatible API)
config.example.py    config template
static/              web UI (vanilla JS, no build step)
install.sh           macOS launchd installer
Dockerfile, docker-compose.yaml, .env.example
deploy/              reverse proxy example
android/             Android client (Kotlin)
mac/                 macOS notification forwarder
```

## License

[MIT](LICENSE)

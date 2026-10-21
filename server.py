#!/usr/bin/env python3
"""
Homing（归巢）—— 接收各类推送，统一存储与展示。

    python3 server.py
    浏览器打开 http://127.0.0.1:<PORT>/

界面需要登录（仅密码）；写入接口用 TOKEN 鉴权，两者互不相干。

入口
  POST /hook/<channel>     通用 webhook，自动识别 GitHub / GitLab / Alertmanager /
  GET  /hook/<channel>     Grafana / 飞书 / 钉钉 / 企微 / Slack / Discord / 任意 JSON / 纯文本
  POST /notify             macOS 转发客户端（mac/）的协议 {app,title,subtitle,body}

仅依赖标准库。
"""

import hashlib
import hmac
import ipaddress
import json
import os
import queue
import re
import secrets
import shutil
import socket
import sqlite3
import subprocess
import sys
import threading
import time
from http.cookies import CookieError, SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
try:
    import config
except ImportError:
    sys.exit("缺少 config.py\n  cp config.example.py config.py  然后填写实际值")

import adapters
import ai
from adapters import LEVELS, normalize, parse_mac, to_level

STATIC = os.path.join(HERE, "static")
MAX_BODY = 2 * 1024 * 1024
MAX_RAW = 64 * 1024

# macOS 转发客户端推来的是 bundle id，这里翻成人话。
# key 一律小写：同一个 app 在系统各处的大小写并不一致。
MAC_APPS = {
    "com.larksuite.larkapp": "飞书",
    "com.electron.lark": "飞书",
    "com.bytedance.lark": "飞书",
    "com.tencent.xinwechat": "微信",
    "com.tencent.qq": "QQ",
    "com.tdesktop.telegram": "Telegram",
    "net.whatsapp.whatsapp": "WhatsApp",
    "com.tencent.workbuddy.mac": "WorkBuddy",
    "com.apple.scripteditor2": "脚本编辑器",
    "com.apple.mail": "邮件",
    "com.apple.ical": "日历",
    "com.apple.reminders": "提醒事项",
    "com.apple.mobilesms": "信息",
    "com.apple.facetime": "FaceTime",
    "com.apple.safari": "Safari",
    "com.microsoft.vscode": "VS Code",
}


# 聊天类 app：同一联系人 / 群的通知归成一个会话。另外凡是系统标记为
# 消息通讯类（unct = UNNotificationContentTypeMessaging*）的通知也算。
CHAT_APPS = {
    "net.whatsapp.whatsapp", "com.tencent.xinwechat", "com.tencent.qq",
    "com.tdesktop.telegram", "ru.keepcoder.telegram", "org.telegram.desktop",
    "com.larksuite.larkapp", "com.electron.lark", "com.bytedance.lark",
    "com.apple.mobilesms", "com.hnc.discord", "com.tinyspeck.slackmacgap",
    "jp.naver.line.mac", "com.facebook.archon", "com.tencent.workwechat",
}


def conversation_of(app, title, raw_obj):
    """聊天通知 → (会话键, 会话名)；不是聊天返回 ("", "")。

    会话按「app + 通知标题」归并：单聊时标题是对方名字，群聊时是群名。
    WhatsApp 虽然带会话 id（req.thre），但旧格式消息没有，统一用标题才能把新旧消息接上。
    """
    req = (raw_obj or {}).get("req") if isinstance(raw_obj, dict) else None
    unct = (req or {}).get("unct") or ""
    if app.lower() not in CHAT_APPS and "Messaging" not in str(unct):
        return "", ""
    name = title or "未知联系人"
    return f"mac/{app.lower()}|{name}", name


def mac_app_name(bundle):
    b = (bundle or "").lower()
    return MAC_APPS.get(b) or (bundle.split(".")[-1] if "." in bundle else bundle) or "未知应用"


# ------------------------------------------------------------------ 存储

_lock = threading.Lock()
_subs = []


def db():
    conn = sqlite3.connect(config.DB_PATH, check_same_thread=False, timeout=10)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with db() as c:
        c.execute("PRAGMA journal_mode=WAL")
        c.execute("""CREATE TABLE IF NOT EXISTS messages(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            channel TEXT NOT NULL,        -- 分组键：mac/<bundle> 或 hook/<name>
            channel_name TEXT NOT NULL,
            source TEXT NOT NULL,         -- 识别出的格式：mac/github/alertmanager/...
            title TEXT, body TEXT, level TEXT, url TEXT, tags TEXT,
            raw TEXT, ts REAL NOT NULL,
            is_read INTEGER DEFAULT 0, starred INTEGER DEFAULT 0)""")
        c.execute("CREATE INDEX IF NOT EXISTS idx_ts ON messages(ts DESC)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_ch ON messages(channel, ts DESC)")
        c.execute("CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT)")

        # AI 整理的结果单独存，原始 title/body/tags 不动，随时能看原文、能重新整理
        cols = {r[1] for r in c.execute("PRAGMA table_info(messages)")}
        if "conv" not in cols:
            c.execute("ALTER TABLE messages ADD COLUMN conv TEXT DEFAULT ''")   # 会话键，空 = 不是聊天
            c.execute("ALTER TABLE messages ADD COLUMN conv_name TEXT DEFAULT ''")
            for mid, ch, title, raw in c.execute(
                    "SELECT id, channel, title, raw FROM messages WHERE source='mac'").fetchall():
                try:
                    obj = json.loads(raw)
                except ValueError:
                    obj = None
                key, name = conversation_of(ch[4:], title, obj)
                if key:
                    c.execute("UPDATE messages SET conv=?, conv_name=? WHERE id=?", (key, name, mid))
        c.execute("CREATE INDEX IF NOT EXISTS idx_conv ON messages(conv, id DESC)")
        if "ai_status" not in cols:
            for col in ("ai_status TEXT DEFAULT ''",   # '' 未处理 / pending / done / failed
                        "ai_title TEXT DEFAULT ''", "ai_summary TEXT DEFAULT ''",
                        "ai_tags TEXT DEFAULT '[]'", "ai_tries INTEGER DEFAULT 0",
                        "ai_level INTEGER DEFAULT 0",    # 1 = 当前级别是 AI 定的，重新整理时可改
                        "filtered INTEGER DEFAULT 0"):   # 1 = 被判为垃圾，默认视图里隐藏
                c.execute(f"ALTER TABLE messages ADD COLUMN {col}")
            # 升级时顺带整理最近 3 天的存量消息
            if ai.enabled():
                c.execute("UPDATE messages SET ai_status='pending' WHERE ts > ?",
                          (time.time() - 3 * 86400,))


# ------------------------------------------------------------------ 级别

# 内置级别的默认外观。key 固定（适配器按它归类），名称、颜色、别名都可在界面里改。
DEFAULT_LEVELS = [
    ("error", "重要", "#e5484d"),
    ("warning", "提醒", "#f5a524"),
    ("success", "完成", "#30a46c"),
    ("info", "普通", "#3e8bf5"),
]
_COLOR_RE = re.compile(r"#[0-9a-fA-F]{6}")


def init_levels():
    with db() as c:
        c.execute("""CREATE TABLE IF NOT EXISTS levels(
            key TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL,
            aliases TEXT DEFAULT '', sort INTEGER DEFAULT 0)""")
        for i, (k, n, col) in enumerate(DEFAULT_LEVELS):
            c.execute("INSERT OR IGNORE INTO levels(key,name,color,sort) VALUES(?,?,?,?)",
                      (k, n, col, 100 + i))
    load_aliases()


def get_levels():
    with db() as c:
        rows = c.execute("SELECT key,name,color,aliases FROM levels ORDER BY sort, rowid").fetchall()
    return [dict(r, builtin=r["key"] in LEVELS) for r in rows]


def load_aliases():
    """把级别的名称、别名都登记成可识别的 level 写法。先到先得，避免后加的覆盖前面的。"""
    table = {}
    for lv in get_levels():
        for word in [lv["key"], lv["name"]] + lv["aliases"].split(","):
            word = word.strip().lower()
            if word:
                table.setdefault(word, lv["key"])
    adapters.ALIASES = table


def save_levels(items):
    """整表替换。内置级别不可删除；被删掉的自定义级别下的消息归入 info。"""
    rows, keys = [], set()
    for it in items:
        name = str(it.get("name") or "").strip()[:12]
        color = str(it.get("color") or "")
        if not name or not _COLOR_RE.fullmatch(color):
            raise ValueError("级别名称不能为空，颜色需为 #rrggbb")
        key = str(it.get("key") or "") or "c_" + secrets.token_hex(3)
        if key in keys:
            continue
        aliases = ",".join(a.strip() for a in re.split(r"[,，\s]+", str(it.get("aliases") or ""))
                           if a.strip())[:200]
        keys.add(key)
        rows.append((key, name, color.lower(), aliases))
    missing = set(LEVELS) - keys
    if missing:
        raise ValueError(f"内置级别不可删除：{', '.join(sorted(missing))}")
    with _lock, db() as c:
        c.execute("DELETE FROM levels")
        c.executemany("INSERT INTO levels(key,name,color,aliases,sort) VALUES(?,?,?,?,?)",
                      [r + (i,) for i, r in enumerate(rows)])
        c.execute(f"UPDATE messages SET level='info' WHERE level NOT IN ({','.join('?' * len(keys))})",
                  list(keys))
    load_aliases()


def purge():
    with _lock, db() as c:
        c.execute("DELETE FROM messages WHERE starred=0 AND ts < ?",
                  (time.time() - config.KEEP_DAYS * 86400,))


def purge_loop():
    while True:
        time.sleep(6 * 3600)
        purge()


LIST_COLS = ("id,channel,channel_name,source,title,body,level,url,tags,ts,is_read,starred,"
             "ai_status,ai_title,ai_summary,ai_tags,filtered,conv,conv_name")


def row_out(r):
    d = dict(r)
    own = json.loads(d.get("tags") or "[]")
    d["tags"] = own + [t for t in json.loads(d.pop("ai_tags", None) or "[]") if t not in own]
    return d


# ------------------------------------------------------------------ 频道静音
#
# 静音的频道不出现在「全部 / 未读 / 标签」里，不计入总未读数，不弹任何通知
# （服务端系统通知、浏览器通知；Android 客户端拉的是默认列表，自然也收不到）。
# 点进该频道、搜索、星标、已过滤视图里照常可见。

_muted = None


def muted():
    global _muted
    if _muted is None:
        _muted = set(json.loads(meta_get("muted_channels", "[]")))
    return _muted


def set_muted(channel, on):
    global _muted
    m = set(muted())
    (m.add if on else m.discard)(channel)
    meta_set("muted_channels", json.dumps(sorted(m), ensure_ascii=False))
    _muted = m


def unmuted_sql(col="channel"):
    """排除静音频道的 SQL 片段和参数。"""
    m = sorted(muted())
    return (f"{col} NOT IN ({','.join('?' * len(m))})", m) if m else ("1=1", [])


def meta_get(k, default=""):
    with db() as c:
        r = c.execute("SELECT v FROM meta WHERE k=?", (k,)).fetchone()
    return r[0] if r else default


def meta_set(k, v):
    with _lock, db() as c:
        c.execute("INSERT OR REPLACE INTO meta VALUES(?,?)", (k, v))


def broadcast(event):
    for q in list(_subs):
        try:
            q.put_nowait(event)
        except queue.Full:
            pass


def store(channel, channel_name, msg, raw, ts=None, conv=("", "")):
    now = time.time()
    # 来源给的时间只在合理范围内采信（重投延迟到达时更准），否则用接收时间
    ts = ts if ts and now - 7 * 86400 < ts <= now + 60 else now
    pending = ai_on()
    with _lock, db() as c:
        cur = c.execute(
            "INSERT INTO messages(channel,channel_name,source,title,body,level,url,tags,raw,ts,ai_status,"
            "conv,conv_name) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (channel, channel_name, msg["source"], msg.get("title", ""),
             msg.get("body", ""), msg.get("level", "info"), msg.get("url", ""),
             json.dumps(msg.get("tags") or [], ensure_ascii=False),
             raw[:MAX_RAW], ts, "pending" if pending else "", conv[0], conv[1]))
        row = c.execute(f"SELECT {LIST_COLS} FROM messages WHERE id=?",
                        (cur.lastrowid,)).fetchone()
    out = row_out(row)
    # 先入库、先推给页面，AI 在后台慢慢整理；AI 挂了也不影响收消息
    broadcast({"type": "new", "msg": out})
    if pending:
        ai_enqueue(out["id"])
    else:
        system_notify(out)          # 开了 AI 的话等整理完、确认不是垃圾再弹
    print(f"← [{channel_name}] {out['level']:7} {(out['title'] or out['body'])[:60]}")
    return out


# ------------------------------------------------------------------ AI 整理

AI_MAX_TRIES = 3
# 失败的消息每隔一段时间自动再试一轮，超过时限就不再管（详情页 ✦ 仍可手动重试）。
# AI 服务或隧道中断恢复后，期间的消息能自己补上，不用手工重排队。
AI_RETRY_EVERY = 30 * 60
AI_RETRY_WITHIN = 24 * 3600
_ai_q = queue.Queue()
_ai_queued = set()
_ai_qlock = threading.Lock()


def ai_on():
    return ai.enabled() and meta_get("ai_enabled", "1") == "1"


def ai_enqueue(mid):
    with _ai_qlock:
        if mid in _ai_queued:
            return
        _ai_queued.add(mid)
    _ai_q.put(mid)


def known_tags(limit=30):
    """最近常用的标签，喂给模型让它优先复用，避免同义标签越长越多。"""
    counts = {}
    with db() as c:
        for (t,) in c.execute("SELECT ai_tags FROM messages ORDER BY id DESC LIMIT 1000"):
            for tag in json.loads(t or "[]"):
                counts[tag] = counts.get(tag, 0) + 1
    return [t for t, _ in sorted(counts.items(), key=lambda x: -x[1])[:limit]]


def ai_process(mid):
    with db() as c:
        r = c.execute("SELECT * FROM messages WHERE id=?", (mid,)).fetchone()
    # retry = 失败后自动重试的；它失败时的通知已经弹过，整理完不再弹
    if not r or r["ai_status"] not in ("pending", "retry"):
        return
    again = r["ai_status"] == "retry"
    try:
        res = ai.classify(dict(r), get_levels(), known_tags(), meta_get("ai_rules"))
    except Exception as e:
        tries = r["ai_tries"] + 1
        status = "failed" if tries >= AI_MAX_TRIES else r["ai_status"]   # 未到上限的由重试循环再捡
        with _lock, db() as c:
            c.execute("UPDATE messages SET ai_tries=?, ai_status=? WHERE id=?", (tries, status, mid))
        print(f"[ai] #{mid} 第 {tries} 次失败：{type(e).__name__}: {e}")
        if status == "failed":
            finish(mid, notify=not again)
        return
    # 只动「默认级别」或「上次由 AI 定的级别」；推送方指定的、用户手动改的都不碰
    may_relevel = r["level"] == "info" or r["ai_level"]
    level, by_ai = (res["level"], 1) if may_relevel and res["level"] else (r["level"], r["ai_level"])
    with _lock, db() as c:
        c.execute("""UPDATE messages SET ai_status='done', ai_title=?, ai_summary=?, ai_tags=?,
                     level=?, ai_level=?, filtered=?, is_read=CASE WHEN ? THEN 1 ELSE is_read END
                     WHERE id=?""",
                  (res["title"], res["summary"], json.dumps(res["tags"], ensure_ascii=False),
                   level, by_ai, int(res["spam"]), int(res["spam"]), mid))
    print(f"[ai] #{mid} {'🗑 ' if res['spam'] else ''}{res['title']} {res['tags']}")
    finish(mid, notify=not again)


def finish(mid, notify=True):
    with db() as c:
        m = row_out(c.execute(f"SELECT {LIST_COLS} FROM messages WHERE id=?", (mid,)).fetchone())
    broadcast({"type": "update", "msg": m})
    if notify and not m["filtered"]:
        system_notify(m)


def ai_worker():
    while True:
        mid = _ai_q.get()
        try:
            ai_process(mid)
        except Exception as e:
            print(f"[ai] #{mid} 处理异常：{e}")
        finally:
            with _ai_qlock:
                _ai_queued.discard(mid)


def ai_retry_loop():
    """捡起重启前没处理完的、上次失败待重试的；失败的每 AI_RETRY_EVERY 秒再给一轮机会。"""
    last_round = 0
    while True:
        if ai_on():
            if time.time() - last_round >= AI_RETRY_EVERY:
                last_round = time.time()
                with _lock, db() as c:
                    n = c.execute("UPDATE messages SET ai_status='retry', ai_tries=0 "
                                  "WHERE ai_status='failed' AND ts > ?",
                                  (time.time() - AI_RETRY_WITHIN,)).rowcount
                if n:
                    print(f"[ai] 重试 {n} 条之前失败的消息")
            with db() as c:
                ids = [r[0] for r in c.execute(
                    "SELECT id FROM messages WHERE ai_status IN ('pending','retry') ORDER BY id")]
            for mid in ids:
                ai_enqueue(mid)
        time.sleep(60)


HAS_TN = shutil.which("terminal-notifier")
HAS_OSA = shutil.which("osascript")


def system_notify(m):
    if not config.SYSTEM_NOTIFY or not (HAS_TN or HAS_OSA) or m["channel"] in muted():
        return
    head = f"[{m['channel_name']}] {m['ai_title'] or m['title']}".strip()
    text = (m["ai_summary"] or m["body"] or "")[:200] or " "
    url = f"http://127.0.0.1:{config.PORT}/#/m/{m['id']}"
    if HAS_TN:
        cmd = ["terminal-notifier", "-title", head, "-message", text,
               "-group", m["channel"], "-open", url]
    else:
        q = lambda s: '"' + s.replace("\\", "\\\\").replace('"', '\\"').replace("\n", " ") + '"'
        cmd = ["osascript", "-e", f"display notification {q(text)} with title {q(head)}"]
    subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


# ------------------------------------------------------------------ 查询

def query_messages(p):
    where, args = [], []
    if p.get("channel"):
        where.append("channel=?"); args.append(p["channel"])
    if p.get("conv"):
        where.append("conv=?"); args.append(p["conv"])
    if p.get("level"):
        where.append("level=?"); args.append(p["level"])
    # 被过滤的只在「已过滤」视图里出现
    where.append("filtered=?"); args.append(1 if p.get("view") == "filtered" else 0)
    if p.get("view") == "unread":
        where.append("is_read=0")
    elif p.get("view") == "starred":
        where.append("starred=1")
    # 汇总类视图排除静音频道；指定了频道 / 会话、搜索、星标、已过滤时照常显示
    if (p.get("view") in (None, "", "all", "unread") and not p.get("channel")
            and not p.get("conv") and not p.get("q")):
        cond, a = unmuted_sql()
        where.append(cond); args += a
    if p.get("tag"):
        like = "%" + json.dumps(p["tag"], ensure_ascii=False) + "%"
        where.append("(tags LIKE ? OR ai_tags LIKE ?)")
        args += [like] * 2
    if p.get("q"):
        like = f"%{p['q']}%"
        where.append("(title LIKE ? OR body LIKE ? OR channel_name LIKE ? OR tags LIKE ?"
                     " OR ai_title LIKE ? OR ai_summary LIKE ? OR ai_tags LIKE ?)")
        args += [like] * 7
    if p.get("before"):
        where.append("id<?"); args.append(int(p["before"]))
    limit = min(int(p.get("limit") or 50), 200)
    sql = f"SELECT {LIST_COLS} FROM messages"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY id DESC LIMIT ?"
    with db() as c:
        rows = c.execute(sql, args + [limit + 1]).fetchall()
    return {"items": [row_out(r) for r in rows[:limit]], "has_more": len(rows) > limit}


def channels():
    with db() as c:
        rows = c.execute("""
            SELECT channel, source,
                   (SELECT channel_name FROM messages m2 WHERE m2.channel=m.channel
                    ORDER BY id DESC LIMIT 1) AS channel_name,
                   COUNT(*) AS total, SUM(is_read=0) AS unread, MAX(ts) AS last_ts
            FROM messages m WHERE filtered=0 GROUP BY channel ORDER BY last_ts DESC""").fetchall()
        um, um_args = unmuted_sql()
        stats = c.execute(f"""SELECT SUM(filtered=0 AND {um}) total,
                              SUM(is_read=0 AND filtered=0 AND {um}) unread,
                              SUM(starred=1 AND filtered=0) starred, SUM(filtered=1) filtered
                              FROM messages""", um_args * 2).fetchone()
        tag_rows = c.execute(f"SELECT tags, ai_tags FROM messages WHERE filtered=0 AND ts > ? AND {um}",
                             [time.time() - 30 * 86400] + um_args).fetchall()
    counts = {}
    for own, gen in tag_rows:
        for t in set(json.loads(own or "[]") + json.loads(gen or "[]")):
            counts[t] = counts.get(t, 0) + 1
    tags = sorted(counts.items(), key=lambda x: (-x[1], x[0]))[:20]
    with db() as c:
        conv_unread = dict(c.execute("SELECT conv, COUNT(*) FROM messages WHERE conv!='' "
                                     "AND is_read=0 AND filtered=0 GROUP BY conv").fetchall())
    mset = muted()
    return {"channels": [dict(r, muted=r["channel"] in mset) for r in rows],
            "conv_unread": conv_unread,
            "total": stats["total"] or 0, "unread": stats["unread"] or 0,
            "starred": stats["starred"] or 0, "filtered": stats["filtered"] or 0,
            "tags": [{"tag": t, "count": n} for t, n in tags]}


def ai_settings():
    with db() as c:
        st = dict(c.execute("SELECT ai_status, COUNT(*) FROM messages "
                            "WHERE ai_status!='' GROUP BY ai_status").fetchall())
    return {"configured": ai.enabled(), "url": config.AI_URL,
            "model": config.AI_MODEL or getattr(ai, "_model", None) or "",
            "enabled": meta_get("ai_enabled", "1") == "1", "rules": meta_get("ai_rules"),
            "pending": st.get("pending", 0) + st.get("retry", 0), "failed": st.get("failed", 0)}


def lan_ips():
    ips = set()
    try:
        out = subprocess.run(["ifconfig"], capture_output=True, text=True, timeout=2).stdout
        for line in out.splitlines():
            parts = line.split()
            if len(parts) > 1 and parts[0] == "inet":
                ip = ipaddress.ip_address(parts[1])
                if ip.is_private and not ip.is_loopback:
                    ips.add(str(ip))
    except Exception:
        try:
            ips.add(socket.gethostbyname(socket.gethostname()))
        except OSError:
            pass
    return sorted(ips)


# ------------------------------------------------------------------ 登录

SESSION_COOKIE = "homing_session"
_secret = ""


def init_secret():
    """签名密钥存在库里而不是内存里：服务重启后已登录的设备不用重新登录。"""
    global _secret
    with db() as c:
        c.execute("CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT)")
        c.execute("INSERT OR IGNORE INTO meta VALUES('secret', ?)", (secrets.token_hex(32),))
        _secret = c.execute("SELECT v FROM meta WHERE k='secret'").fetchone()[0]


def _sign(payload):
    # 密码参与派生密钥：改密码 = 所有旧会话立即作废
    key = hmac.new(_secret.encode(), config.PASSWORD.encode(), hashlib.sha256).digest()
    return hmac.new(key, payload.encode(), hashlib.sha256).hexdigest()


def new_session():
    exp = str(int(time.time()) + config.SESSION_DAYS * 86400)
    return f"{exp}.{_sign(exp)}"


def session_valid(value):
    exp, _, sig = (value or "").partition(".")
    return exp.isdigit() and int(exp) > time.time() and hmac.compare_digest(sig, _sign(exp))


# 防爆破：单 IP 15 分钟内错 5 次锁定；全局错 30 次也锁定。
# 全局上限是兜底 —— 攻击者换 IP 可以躲开单 IP 限制。
LOGIN_WINDOW, LOGIN_PER_IP, LOGIN_GLOBAL = 900, 5, 30
_fails = []                      # [(ts, ip)]
_fails_lock = threading.Lock()


def login_retry_after(ip):
    """被锁定时返回还需等待的秒数，否则 0。"""
    now = time.time()
    with _fails_lock:
        _fails[:] = [f for f in _fails if now - f[0] < LOGIN_WINDOW]
        mine = [t for t, i in _fails if i == ip]
        if len(mine) >= LOGIN_PER_IP:
            return int(mine[0] + LOGIN_WINDOW - now) + 1
        if len(_fails) >= LOGIN_GLOBAL:
            return int(_fails[0][0] + LOGIN_WINDOW - now) + 1
    return 0


def login_failed(ip):
    with _fails_lock:
        _fails.append((time.time(), ip))


def login_succeeded(ip):
    with _fails_lock:
        _fails[:] = [f for f in _fails if f[1] != ip]


# ------------------------------------------------------------------ HTTP

MIME = {".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
        ".js": "application/javascript; charset=utf-8", ".svg": "image/svg+xml",
        ".json": "application/json", ".png": "image/png", ".webmanifest": "application/manifest+json"}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    # ---- 基础 ----
    def _send(self, code, body=b"", ctype="text/plain; charset=utf-8", headers=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if body and self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, obj, code=200):
        self._send(code, json.dumps(obj, ensure_ascii=False).encode(),
                   "application/json; charset=utf-8")

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_BODY:
            raise ValueError("too large")
        return self.rfile.read(n) if n else b""

    def _url(self):
        u = urlparse(self.path)
        return u.path, {k: v[0] for k, v in parse_qs(u.query).items()}

    def _client_ip(self):
        # 只认 X-Real-IP：反代用 proxy_set_header 把它覆盖成真实对端地址，客户端伪造不了。
        # X-Forwarded-For 首段、CF-Connecting-IP 都能被直连源站的人随意填写，不可信。
        if config.TRUST_PROXY and self.headers.get("X-Real-IP"):
            return self.headers["X-Real-IP"]
        return self.client_address[0]

    def _https(self):
        return (self.headers.get("X-Forwarded-Proto") == "https"
                or '"https"' in (self.headers.get("CF-Visitor") or ""))

    def _token_ok(self, query):
        auth = self.headers.get("Authorization", "")
        given = (self.headers.get("X-Token")
                 or (auth[7:] if auth.lower().startswith("bearer ") else "")
                 or query.get("token", ""))
        return hmac.compare_digest(given.encode(), config.TOKEN.encode())

    def _authed(self):
        try:
            c = SimpleCookie(self.headers.get("Cookie", ""))
        except CookieError:
            return False
        return SESSION_COOKIE in c and session_valid(c[SESSION_COOKIE].value)

    def _cookie(self, value, max_age):
        secure = "; Secure" if self._https() else ""
        return (f"{SESSION_COOKIE}={value}; Path=/; HttpOnly; SameSite=Lax; "
                f"Max-Age={max_age}{secure}")

    def _redirect(self, to):
        self._send(302, b"", headers={"Location": to})

    def _login(self, d):
        ip = self._client_ip()
        wait = login_retry_after(ip)
        if wait:
            return self._json({"error": f"尝试次数过多，请 {wait // 60 + 1} 分钟后再试"}, 429)
        if not hmac.compare_digest(str(d.get("password", "")).encode(), config.PASSWORD.encode()):
            login_failed(ip)
            print(f"[login] 密码错误 {ip}")
            time.sleep(1)   # 拖慢逐个试
            return self._json({"error": "密码错误"}, 401)
        login_succeeded(ip)
        print(f"[login] 登录成功 {ip}")
        body = json.dumps({"ok": True}).encode()
        self._send(200, body, "application/json; charset=utf-8",
                   {"Set-Cookie": self._cookie(new_session(), config.SESSION_DAYS * 86400)})

    # ---- 写入入口 ----
    def _ingest_hook(self, path, query):
        if not self._token_ok(query):
            return self._send(401, b"bad token")
        name = unquote(path[len("/hook/"):]).strip("/") or "default"
        raw = self._body() if self.command == "POST" else b""
        msg = normalize(name, self.headers, raw, query)
        display = query.get("name") or name
        m = store(f"hook/{name}", display, msg, raw.decode("utf-8", "replace"))
        self._json({"ok": True, "id": m["id"]})

    def _ingest_mac(self, query):
        """macOS 转发客户端的协议：新版推原始通知记录，旧版推整理好的字段，都认。"""
        if not self._token_ok(query):
            return self._send(401, b"bad token")
        raw = self._body()
        try:
            n = json.loads(raw)
        except ValueError:
            return self._send(400, b"bad json")
        if not isinstance(n, dict):
            return self._send(400, b"bad payload")
        app, title, body, ts, uuid = parse_mac(n)
        # 转发客户端在收不到 2xx 时会重投；同一条通知（uuid 相同）只存一次
        if uuid and self._seen_uuid(uuid):
            return self._send(200, b"dup")
        msg = dict(source="mac", title=title, body=body or ("" if title else "(空通知)"),
                   level=to_level(n.get("level")), url="", tags=[])
        store(f"mac/{app.lower()}", mac_app_name(app), msg, raw.decode("utf-8", "replace"), ts,
              conversation_of(app, title, n))
        self._send(200, b"ok")

    @staticmethod
    def _seen_uuid(uuid):
        with db() as c:
            return c.execute("SELECT 1 FROM messages WHERE source='mac' AND ts > ? AND raw LIKE ?",
                             (time.time() - 2 * 86400, f'%"uuid": {json.dumps(uuid)}%')).fetchone()

    # ---- 路由 ----
    def do_POST(self):
        path, query = self._url()
        try:
            if path.startswith("/hook/") or path == "/hook":
                return self._ingest_hook(path + ("/" if path == "/hook" else ""), query)
            if path == "/notify":
                return self._ingest_mac(query)
            if not path.startswith("/api/"):
                return self._send(404, b"not found")
            # 强制 JSON：跨站页面发不出这种请求（会触发预检），配合 SameSite 防 CSRF
            if "application/json" not in (self.headers.get("Content-Type") or ""):
                return self._send(415, b"json only")
            data = json.loads(self._body() or b"{}")
            if path == "/api/login":
                return self._login(data)
            if path == "/api/logout":
                return self._send(200, b'{"ok":true}', "application/json",
                                  {"Set-Cookie": self._cookie("", 0)})
            if not self._authed():
                return self._json({"error": "unauthorized"}, 401)
            return self._api_post(path, data)
        except ValueError as e:
            return self._send(400, f"bad request: {e}".encode())

    def _api_post(self, path, d):
        ids = [int(i) for i in d.get("ids") or []]

        def scope():
            if ids:
                return f"id IN ({','.join('?' * len(ids))})", ids
            conds, args = ["filtered=0"], []
            for col in ("channel", "level", "conv"):      # 可同时限定
                if d.get(col):
                    conds.append(f"{col}=?"); args.append(d[col])
            if not d.get("channel") and not d.get("conv"):
                cond, a = unmuted_sql()                   # 汇总视图里看不到静音频道，也别动它们
                conds.append(cond); args += a
            return " AND ".join(conds), args

        if path == "/api/read":
            cond, args = scope()
            val = 0 if d.get("unread") else 1
            with _lock, db() as c:
                c.execute(f"UPDATE messages SET is_read=? WHERE {cond}", [val] + args)
        elif path == "/api/star":
            with _lock, db() as c:
                c.execute("UPDATE messages SET starred=? WHERE id=?",
                          (1 if d.get("starred") else 0, int(d["id"])))
        elif path == "/api/level":
            level = str(d.get("level", ""))
            if level not in {lv["key"] for lv in get_levels()}:
                return self._send(400, b"unknown level")
            with _lock, db() as c:
                c.execute("UPDATE messages SET level=?, ai_level=0 WHERE id=?", (level, int(d["id"])))
        elif path == "/api/mute":
            set_muted(str(d["channel"]), bool(d.get("muted")))
        elif path == "/api/spam":
            # 手动纠正 AI 的判断
            with _lock, db() as c:
                c.execute("UPDATE messages SET filtered=? WHERE id=?",
                          (1 if d.get("filtered") else 0, int(d["id"])))
        elif path == "/api/reprocess":
            if not ai.enabled():
                return self._send(400, b"AI not configured")
            mid = int(d["id"])
            with _lock, db() as c:
                c.execute("UPDATE messages SET ai_status='pending', ai_tries=0 WHERE id=?", (mid,))
            ai_enqueue(mid)
        elif path == "/api/ai":
            meta_set("ai_enabled", "1" if d.get("enabled") else "0")
            meta_set("ai_rules", str(d.get("rules") or "")[:2000])
            return self._json(ai_settings())
        elif path == "/api/levels":
            save_levels(d.get("levels") or [])
            broadcast({"type": "levels"})
            return self._json(get_levels())
        elif path == "/api/delete":
            if not ids and not d.get("channel") and not d.get("conv") and not d.get("all"):
                return self._send(400, b"need ids / channel / all")
            cond, args = scope()
            with _lock, db() as c:
                c.execute(f"DELETE FROM messages WHERE {cond}", args)
        elif path == "/api/test":
            msg = normalize("test", {}, json.dumps({
                "title": "测试通知", "level": d.get("level", "info"),
                "body": "这是一条来自 **归巢** 的测试消息。\n\n- 支持 Markdown\n- 支持 `代码` 与 [链接](https://example.com)",
            }).encode(), {})
            store("hook/test", "测试", msg, "")
            return self._json({"ok": True})
        else:
            return self._send(404, b"not found")
        # 带上发起方页面的标识，那个页面本地已更新，收到后不必重拉
        broadcast({"type": "sync", "src": self.headers.get("X-Client", "")})
        self._json({"ok": True})

    def do_GET(self):
        path, query = self._url()
        if path.startswith("/hook/"):
            return self._ingest_hook(path, query)
        if path == "/health":
            return self._send(200, b"ok")

        authed = self._authed()
        if path in ("/", "/index.html"):
            return self._static("/index.html") if authed else self._redirect("/login")
        if path == "/login":
            return self._redirect("/") if authed else self._static("/login.html")
        if not path.startswith("/api/"):
            return self._static(path)      # css / js / 图标，不含任何数据
        if not authed:
            return self._json({"error": "unauthorized"}, 401)

        if path == "/api/messages":
            return self._json(query_messages(query))
        if path == "/api/channels":
            return self._json(channels())
        if path == "/api/levels":
            return self._json(get_levels())
        if path == "/api/ai":
            return self._json(ai_settings())
        if path.startswith("/api/message/"):
            with db() as c:
                r = c.execute("SELECT * FROM messages WHERE id=?",
                              (int(path.rsplit("/", 1)[1]),)).fetchone()
            return self._json(row_out(r)) if r else self._send(404, b"not found")
        if path == "/api/info":
            # 有公网地址时不列内网 IP（容器里拿到的是 docker 网段，没意义）
            return self._json({"port": config.PORT,
                               "ips": [] if config.PUBLIC_URL else lan_ips(),
                               "public_url": config.PUBLIC_URL.rstrip("/"),
                               "token": config.TOKEN})
        if path == "/api/stream":
            return self._stream()
        return self._send(404, b"not found")

    def _static(self, path):
        f = os.path.normpath(os.path.join(STATIC, path.lstrip("/")))
        if not f.startswith(STATIC) or not os.path.isfile(f):
            return self._send(404, b"not found")
        with open(f, "rb") as fh:
            body = fh.read()
        self._send(200, body, MIME.get(os.path.splitext(f)[1], "application/octet-stream"),
                   {"Cache-Control": "no-cache"})

    def _stream(self):
        q = queue.Queue(maxsize=200)
        _subs.append(q)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        self.close_connection = True
        try:
            self.wfile.write(b"retry: 3000\n\n")
            while True:
                try:
                    ev = q.get(timeout=20)
                    self.wfile.write(f"data: {json.dumps(ev, ensure_ascii=False)}\n\n".encode())
                except queue.Empty:
                    self.wfile.write(b": ping\n\n")
                self.wfile.flush()
        except Exception:
            pass
        finally:
            if q in _subs:
                _subs.remove(q)

    def log_message(self, *a):
        pass


class Server(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        if isinstance(sys.exc_info()[1], (ConnectionResetError, BrokenPipeError,
                                          ConnectionAbortedError)):
            return
        super().handle_error(request, client_address)


def main():
    weak = [k for k in ("PASSWORD", "TOKEN") if getattr(config, k, "") in ("", "change-me")]
    if weak:
        sys.exit(f"请先在 config.py（或环境变量 HOMING_{weak[0]}）里设置 {' / '.join(weak)}")
    init_db()
    init_secret()
    init_levels()
    purge()
    threading.Thread(target=purge_loop, daemon=True).start()
    if ai.enabled():
        threading.Thread(target=ai_worker, daemon=True).start()
        threading.Thread(target=ai_retry_loop, daemon=True).start()
    with db() as c:
        n = c.execute("SELECT COUNT(*) FROM messages").fetchone()[0]
    print(f"数据库  {config.DB_PATH}（{n} 条）")
    print(f"界面    {config.PUBLIC_URL or f'http://127.0.0.1:{config.PORT}'}/")
    print(f"监听    {config.HOST}:{config.PORT}")
    print(f"AI      {config.AI_URL + (' ' + config.AI_MODEL if config.AI_MODEL else '') if ai.enabled() else '未配置'}")
    print()
    try:
        Server((config.HOST, config.PORT), Handler).serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")


if __name__ == "__main__":
    main()

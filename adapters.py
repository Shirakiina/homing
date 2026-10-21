"""
把各种来源的推送归一成统一的消息结构。

    normalize(channel, headers, raw_bytes, query) -> dict(
        source, title, body, level, url, tags)

识别顺序：专属 Header（GitHub/GitLab）→ JSON 结构特征 → 通用字段猜测 → 纯文本。
query 参数里的 title/body/level/url 最后覆盖，方便临时调试或给简单工具用。
"""

import json
import re
from urllib.parse import parse_qs

# 真正的 form 编码里不会有裸空格和换行（空格会编码成 +）
_FORM_RE = re.compile(r"[\w.\-\[\]]+=[^&\s]*(&[\w.\-\[\]]+=[^&\s]*)*")

# 内置级别。适配器按这四个语义归类（告警 firing → error 等），名称和颜色在界面里可改。
LEVELS = ("error", "warning", "success", "info")

# 用户自定义的「别名 → 级别 key」，由 server 从数据库加载后注入。优先于内置词表，
# 所以推送时 level=快递 这种写法能直接落到用户建的「快递」级别上。
ALIASES = {}

_LEVEL_WORDS = {
    "error": ("error", "err", "critical", "crit", "fatal", "fail", "failed",
              "failure", "firing", "alerting", "emergency", "alert", "high",
              "p0", "p1", "5", "严重", "错误", "失败", "告警"),
    "warning": ("warning", "warn", "medium", "p2", "4", "警告", "注意"),
    "success": ("success", "succeeded", "ok", "resolved", "passed", "done",
                "completed", "healthy", "成功", "恢复", "完成"),
}


def to_level(v):
    s = str(v or "").strip().lower()
    if s in ALIASES:
        return ALIASES[s]
    if s in LEVELS:
        return s
    for level, words in _LEVEL_WORDS.items():
        if s in words:
            return level
    return "info"


def _first(d, *keys):
    for k in keys:
        v = d.get(k)
        if isinstance(v, (str, int, float)) and str(v).strip():
            return str(v)
    return ""


def _line(s):
    """多行文本的首行；空串安全。"""
    return (s or "").strip().split("\n", 1)[0]


def _parse(headers, raw):
    ctype = (headers.get("Content-Type") or "").lower()
    text = raw.decode("utf-8", "replace").strip()
    # curl -d 默认就带 form 头，哪怕发的是纯文本；解析不出键值对就当文本处理
    form = {k: v[0] for k, v in parse_qs(text).items()} \
        if "application/x-www-form-urlencoded" in ctype and _FORM_RE.fullmatch(text) else None
    if form:
        # GitHub 选 form 格式时把 JSON 放在 payload 字段里
        if "payload" in form:
            try:
                return json.loads(form["payload"])
            except ValueError:
                pass
        return form
    if text[:1] in ("{", "["):
        try:
            return json.loads(text)
        except ValueError:
            pass
    return text


# ---------------------------------------------------------------- GitHub

def _github(event, p):
    repo = (p.get("repository") or {}).get("full_name", "")
    sender = (p.get("sender") or {}).get("login", "")
    action = p.get("action", "")
    tags = [t for t in (repo,) if t]

    if event == "ping":
        return dict(title=f"Webhook 已连通 · {repo or 'GitHub'}",
                    body=p.get("zen", ""), level="success", tags=tags)

    if event == "push":
        ref = (p.get("ref") or "").replace("refs/heads/", "").replace("refs/tags/", "")
        commits = p.get("commits") or []
        lines = [f"- `{c.get('id', '')[:7]}` {_line(c.get('message'))}"
                 for c in commits[:10]]
        if len(commits) > 10:
            lines.append(f"- …另有 {len(commits) - 10} 个提交")
        return dict(title=f"{sender} 推送了 {len(commits)} 个提交到 {ref}",
                    body="\n".join(lines), url=p.get("compare", ""),
                    tags=tags + [ref])

    if event in ("pull_request", "pull_request_review"):
        pr = p.get("pull_request") or {}
        merged = action == "closed" and pr.get("merged")
        verb = "合并了" if merged else {
            "opened": "创建了", "closed": "关闭了", "reopened": "重新打开了",
            "submitted": "评审了", "ready_for_review": "提交评审",
        }.get(action, action)
        review = (p.get("review") or {}).get("state", "")
        level = "success" if merged else (
            "warning" if review == "changes_requested" else "info")
        return dict(title=f"{sender} {verb} PR #{pr.get('number')}：{pr.get('title', '')}",
                    body=(p.get("review") or {}).get("body") or pr.get("body") or "",
                    url=pr.get("html_url", ""), level=level, tags=tags)

    if event in ("issues", "issue_comment"):
        issue = p.get("issue") or {}
        comment = p.get("comment") or {}
        verb = "评论了" if event == "issue_comment" else {
            "opened": "创建了", "closed": "关闭了", "reopened": "重新打开了"
        }.get(action, action)
        return dict(title=f"{sender} {verb} #{issue.get('number')}：{issue.get('title', '')}",
                    body=comment.get("body") or issue.get("body") or "",
                    url=comment.get("html_url") or issue.get("html_url", ""),
                    tags=tags)

    if event == "workflow_run":
        run = p.get("workflow_run") or {}
        conclusion = run.get("conclusion") or run.get("status") or ""
        return dict(title=f"{run.get('name', 'Workflow')} · {conclusion or action}",
                    body=f"分支 `{run.get('head_branch', '')}` · "
                         f"{_line((run.get('head_commit') or {}).get('message'))}",
                    url=run.get("html_url", ""), level=to_level(conclusion),
                    tags=tags + [run.get("head_branch", "")])

    if event == "release":
        rel = p.get("release") or {}
        return dict(title=f"发布 {rel.get('tag_name', '')} {rel.get('name') or ''}".strip(),
                    body=rel.get("body") or "", url=rel.get("html_url", ""),
                    level="success", tags=tags)

    if event == "star":
        return dict(title=f"{sender} {'star 了' if action != 'deleted' else '取消 star'} {repo}",
                    body=f"当前 ★ {(p.get('repository') or {}).get('stargazers_count', '')}",
                    url=(p.get("repository") or {}).get("html_url", ""), tags=tags)

    return dict(title=f"GitHub {event}{' · ' + action if action else ''}",
                body=f"{sender} @ {repo}" if repo else sender, tags=tags)


# ---------------------------------------------------------------- GitLab

def _gitlab(event, p):
    proj = (p.get("project") or {}).get("path_with_namespace", "")
    user = (p.get("user") or {}).get("name") or p.get("user_name", "")
    attrs = p.get("object_attributes") or {}
    tags = [t for t in (proj,) if t]

    if event in ("Push Hook", "Tag Push Hook"):
        ref = (p.get("ref") or "").split("/", 2)[-1]
        commits = p.get("commits") or []
        body = "\n".join(f"- `{c.get('id', '')[:8]}` {c.get('title') or _line(c.get('message'))}"
                         for c in commits[:10])
        return dict(title=f"{user} 推送了 {p.get('total_commits_count', len(commits))} 个提交到 {ref}",
                    body=body, url=(p.get("project") or {}).get("web_url", ""),
                    tags=tags + [ref])

    if event == "Merge Request Hook":
        state = attrs.get("action") or attrs.get("state", "")
        return dict(title=f"{user} {state} MR !{attrs.get('iid')}：{attrs.get('title', '')}",
                    body=attrs.get("description") or "", url=attrs.get("url", ""),
                    level="success" if state == "merge" else "info", tags=tags)

    if event == "Pipeline Hook":
        status = attrs.get("status", "")
        return dict(title=f"Pipeline #{attrs.get('id')} · {status}",
                    body=f"分支 `{attrs.get('ref', '')}` · {(p.get('commit') or {}).get('title', '')}",
                    url=attrs.get("url") or (p.get("project") or {}).get("web_url", ""),
                    level=to_level(status), tags=tags + [attrs.get("ref", "")])

    if event == "Job Hook":
        status = p.get("build_status", "")
        return dict(title=f"Job {p.get('build_name', '')} · {status}",
                    body=f"阶段 {p.get('build_stage', '')} · 分支 `{p.get('ref', '')}`",
                    level=to_level(status), tags=tags)

    if event in ("Issue Hook", "Note Hook"):
        target = p.get("issue") or p.get("merge_request") or attrs
        return dict(title=f"{user} {'评论了' if event == 'Note Hook' else attrs.get('action', '')} "
                          f"{target.get('title', '')}",
                    body=attrs.get("note") or attrs.get("description") or "",
                    url=attrs.get("url", ""), tags=tags)

    return dict(title=f"GitLab {event}", body=proj, tags=tags)


# ---------------------------------------------------------------- 告警类

def _alertmanager(p):
    """Prometheus Alertmanager 和 Grafana 统一告警共用这个结构。"""
    status = p.get("status", "")
    alerts = p.get("alerts") or []
    common = p.get("commonLabels") or {}
    name = common.get("alertname") or (alerts[0].get("labels", {}).get("alertname") if alerts else "")
    lines = []
    for a in alerts[:20]:
        ann = a.get("annotations") or {}
        labels = a.get("labels") or {}
        who = labels.get("instance") or labels.get("pod") or labels.get("job") or ""
        desc = ann.get("summary") or ann.get("description") or ann.get("message") or ""
        mark = "🔴" if a.get("status") == "firing" else "🟢"
        lines.append(f"{mark} **{who or labels.get('alertname', '')}** {desc}".strip())
    title = p.get("title") or f"[{status.upper()}{':' + str(len(alerts)) if len(alerts) > 1 else ''}] {name}"
    severity = common.get("severity", "")
    level = "success" if status == "resolved" else (to_level(severity) if severity else "error")
    return dict(title=title, body=p.get("message") if not lines else "\n".join(lines),
                url=p.get("externalURL", ""), level=level,
                tags=[t for t in (severity, common.get("job", "")) if t])


# ---------------------------------------------------------------- IM 机器人格式

def _feishu(p):
    """兼容飞书/Lark 自定义机器人消息体：text / post / interactive。"""
    t = p.get("msg_type")
    c = p.get("content") or {}
    if t == "text":
        return dict(title="", body=c.get("text", ""))
    if t == "post":
        post = c.get("post") or {}
        lang = post.get("zh_cn") or post.get("en_us") or next(iter(post.values()), {})
        lines = []
        for para in lang.get("content", []):
            line = ""
            for el in para:
                tag = el.get("tag")
                if tag == "a":
                    line += f"[{el.get('text', '')}]({el.get('href', '')})"
                elif tag == "at":
                    line += "@" + (el.get("user_name") or el.get("user_id", ""))
                else:
                    line += el.get("text", "")
            lines.append(line)
        return dict(title=lang.get("title", ""), body="\n".join(lines))
    if t == "interactive":
        card = p.get("card") or {}
        header = (card.get("header") or {}).get("title") or {}
        texts = []

        def walk(node):
            if isinstance(node, dict):
                if node.get("tag") in ("lark_md", "plain_text", "markdown") and node.get("content"):
                    texts.append(node["content"])
                for v in node.values():
                    walk(v)
            elif isinstance(node, list):
                for v in node:
                    walk(v)
        walk(card.get("elements") or card.get("body") or [])
        template = (card.get("header") or {}).get("template", "")
        level = {"red": "error", "orange": "warning", "yellow": "warning",
                 "green": "success"}.get(template, "info")
        return dict(title=header.get("content", ""), body="\n\n".join(texts), level=level)
    return None


def _dingtalk_wecom(p):
    """钉钉 / 企业微信机器人：msgtype = text | markdown | link | actionCard。"""
    t = p.get("msgtype")
    c = p.get(t) or {}
    if t == "text":
        return dict(title="", body=c.get("content", ""))
    if t == "markdown":
        return dict(title=c.get("title", ""), body=c.get("text") or c.get("content", ""))
    if t == "link":
        return dict(title=c.get("title", ""), body=c.get("text", ""),
                    url=c.get("messageUrl", ""))
    if t == "actionCard":
        return dict(title=c.get("title", ""), body=c.get("text", ""),
                    url=c.get("singleURL", ""))
    return None


def _slack(p):
    texts = [p.get("text", "")] if p.get("text") else []
    for b in p.get("blocks") or []:
        txt = b.get("text")
        if isinstance(txt, dict) and txt.get("text"):
            texts.append(txt["text"])
    level = "info"
    for a in p.get("attachments") or []:
        texts.append(a.get("text") or a.get("fallback") or "")
        level = {"danger": "error", "warning": "warning", "good": "success"}.get(a.get("color"), level)
    return dict(title="", body="\n\n".join(t for t in texts if t), level=level)


def _discord(p):
    embeds = p.get("embeds") or []
    e = embeds[0] if embeds else {}
    body = "\n\n".join(x for x in (p.get("content"), e.get("description")) if x)
    return dict(title=e.get("title", ""), body=body, url=e.get("url", ""))


# ---------------------------------------------------------------- 通用

def _generic(p):
    # from / sender / phone：短信转发类工具的发件人字段
    title = _first(p, "title", "subject", "summary", "name", "event", "head",
                   "from", "sender", "phone")
    body = _first(p, "body", "message", "content", "text", "description",
                  "desc", "msg", "detail", "details")
    if not title and not body:
        # 实在认不出来：把 JSON 原样放进正文，至少不丢信息
        body = "```\n" + json.dumps(p, ensure_ascii=False, indent=2)[:4000] + "\n```"
    tags = p.get("tags")
    if isinstance(tags, str):
        tags = [t.strip() for t in tags.split(",") if t.strip()]
    return dict(title=title, body=body,
                level=to_level(_first(p, "level", "severity", "priority", "status", "type")),
                url=_first(p, "url", "link", "href", "html_url", "click"),
                tags=tags if isinstance(tags, list) else [])


def normalize(channel, headers, raw, query):
    data = _parse(headers, raw)
    out, source = None, "webhook"

    if isinstance(data, dict):
        gh = headers.get("X-GitHub-Event")
        gl = headers.get("X-Gitlab-Event")
        if gh:
            out, source = _github(gh, data), "github"
        elif gl:
            out, source = _gitlab(gl, data), "gitlab"
        elif isinstance(data.get("alerts"), list) and "status" in data:
            source = "grafana" if "orgId" in data or "title" in data else "alertmanager"
            out = _alertmanager(data)
        elif "msg_type" in data:
            out, source = _feishu(data), "feishu"
        elif "msgtype" in data:
            out, source = _dingtalk_wecom(data), "dingtalk"
        elif "embeds" in data or ("content" in data and "username" in data):
            out, source = _discord(data), "discord"
        elif "blocks" in data or "attachments" in data or set(data) <= {"text", "channel", "username", "icon_emoji", "icon_url"} and "text" in data:
            out, source = _slack(data), "slack"
        if out is None:
            out = _generic(data)
    elif isinstance(data, list):
        out = dict(title="", body="```\n" + json.dumps(data, ensure_ascii=False, indent=2)[:4000] + "\n```")
    else:
        text = data or ""
        first, _, rest = text.partition("\n")
        # 多行纯文本：首行当标题
        out = dict(title=first[:200], body=rest.strip()) if rest.strip() else dict(title="", body=text)

    for k in ("title", "body", "url"):
        if query.get(k):
            out[k] = query[k]
    if query.get("level"):
        out["level"] = to_level(query["level"])

    out.setdefault("level", "info")
    out.setdefault("url", "")
    out["tags"] = [t for t in out.get("tags") or [] if t][:8]
    out["source"] = source
    if not out.get("title") and not out.get("body"):
        out["body"] = "(空消息)"
    return out


# ---------------------------------------------------------------- macOS 转发客户端

APPLE_EPOCH = 978307200     # 2001-01-01，macOS 通知记录里 date 的纪元


def _loc_text(v):
    """
    通知字段转文本。系统通知（如 App Store）给的不是字符串，而是待本地化的列表
    [key, 格式, [参数...]]，格式里是 %@ / %1$@ / %d 这类占位符。没有译文可查，
    就用格式串代入参数；实在拼不出来就把字符串元素连起来。
    """
    if isinstance(v, str):
        return v
    if isinstance(v, (int, float)):
        return str(v)
    if not isinstance(v, list):
        return ""
    fmt = next((x for x in v if isinstance(x, str) and "%" in x), None)
    args = next((x for x in v if isinstance(x, list)), [])
    if fmt:
        it = iter(_loc_text(x) for x in args)
        pos = [_loc_text(x) for x in args]

        def sub(m):
            if m.group(1):                       # %1$@ 带序号
                i = int(m.group(1)) - 1
                return pos[i] if 0 <= i < len(pos) else ""
            return next(it, "")
        return re.sub(r"%(?:(\d+)\$)?(?:l{0,2}[@dDuUxXfegs])", sub, fmt).replace("%%", "%")
    return " ".join(t for t in (_loc_text(x) for x in v) if t)


def parse_mac(n):
    """
    macOS 转发客户端推来的通知 → (app, title, body, ts, uuid)。

    两种格式都认：
      新：macOS 通知记录原样（plist 转 JSON），内容在 req.titl / req.subt / req.body
      旧：客户端整理好的 {app, title, subtitle, body}
    """
    app = n.get("app") or "unknown"
    req = n.get("req")
    if isinstance(req, dict):
        title, sub, body = (_loc_text(req.get(k)) for k in ("titl", "subt", "body"))
        ts = None
        if isinstance(n.get("date"), (int, float)):
            ts = n["date"] + APPLE_EPOCH
    else:
        title, sub, body = (_loc_text(n.get(k)) for k in ("title", "subtitle", "body"))
        ts = None
    # WhatsApp 等会在名字前加不可见的方向控制符（U+200E 等），去掉以免显示和搜索出问题
    clean = lambda s: re.sub(r"[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]", "", s or "").strip()
    title, sub, body = clean(title), clean(sub), clean(body)
    body = " · ".join(x for x in (sub, body) if x)
    return app, title, body, ts, str(n.get("uuid") or "")

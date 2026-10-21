#!/usr/bin/env python3
"""
macOS 通知转发：轮询 macOS 通知数据库，把每条新通知原样 POST 到 Homing 服务端。

    python3 notify_forward.py          # 运行
    python3 notify_forward.py --dump   # 打印最近通知的原始结构

解释器需要「完全磁盘访问权限」，见 mac/README.md。
"""

import argparse
import base64
import datetime
import json
import os
import plistlib
import shutil
import sqlite3
import sys
import tempfile
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    import config
except ImportError:
    sys.exit("缺少 config.py：cp config.example.py config.py 后填写")

DB = os.path.expanduser(
    "~/Library/Group Containers/group.com.apple.usernoted/db2/db")
APPLE_EPOCH = 978307200     # 通知时间戳以 2001-01-01 为纪元
RETRY_SECONDS = 30          # 失败的通知隔多久重投一次
GIVE_UP_SECONDS = 3600      # 重投超过这么久仍失败就丢弃
MAX_PENDING = 200


def log(msg):
    print(time.strftime("%m-%d %H:%M:%S"), msg, flush=True)


def read_records():
    """
    连同 -wal/-shm 复制到临时目录再读：新通知先写进 WAL，
    直接只读打开原库读不到（docs/PITFALLS.md 第 3 条）。
    """
    tmp = tempfile.mkdtemp(prefix="notifsnap-")
    try:
        for ext in ("", "-wal", "-shm"):
            if os.path.exists(DB + ext):
                shutil.copy2(DB + ext, os.path.join(tmp, "db" + ext))
        conn = sqlite3.connect(os.path.join(tmp, "db"))
        try:
            blobs = [b for (b,) in conn.execute("SELECT data FROM record")]
        finally:
            conn.close()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    records = []
    for b in blobs:
        try:
            records.append(plistlib.loads(b))
        except Exception:
            pass
    return records


def encode(v):
    """JSON 表示不了的 plist 类型。只做传输编码，不改内容。"""
    if isinstance(v, bytes):
        return base64.b64encode(v).decode()
    if isinstance(v, datetime.datetime):
        return v.isoformat()
    if isinstance(v, plistlib.UID):
        return v.data
    return str(v)


def send(record):
    req = urllib.request.Request(
        config.RECEIVER, data=json.dumps(record, default=encode).encode(),
        headers={"Content-Type": "application/json", "X-Token": config.TOKEN})
    try:
        urllib.request.urlopen(req, timeout=10).read()
        return True
    except Exception:
        return False


def retry(pending):
    """重投一轮，返回仍需重投的列表。整轮只记一行日志，避免远端故障时刷屏。"""
    now = time.time()
    keep, ok, dropped = [], 0, 0
    for first_failed, record in pending:
        if send(record):
            ok += 1
        elif now - first_failed < GIVE_UP_SECONDS:
            keep.append((first_failed, record))
        else:
            dropped += 1
    log(f"↻ 重投：成功 {ok}，丢弃 {dropped}，待重投 {len(keep)}")
    return keep


def run():
    cursor = time.time() - APPLE_EPOCH   # 只转发启动后的通知，重启不刷屏
    seen = set()
    pending = []                          # [(首次失败时间, 通知)]
    last_retry = time.time()
    log(f"转发到 {config.RECEIVER}")

    while True:
        try:
            records = read_records()
        except Exception as e:
            log(f"[warn] 读取通知库失败：{type(e).__name__}: {e}")
            records = None

        if records is not None:
            current = set()
            for d in records:
                uid = str(d.get("uuid"))
                current.add(uid)
                if uid in seen or (d.get("date") or 0) <= cursor:
                    continue
                seen.add(uid)
                if send(d):
                    log(f"→ {d.get('app')}")
                else:
                    pending.append((time.time(), d))
                    log(f"× {d.get('app')}（发送失败，稍后重投）")
            # record 表只保留 macOS 通知中心里未清除的通知，seen 跟着收缩
            seen &= current

        pending = pending[-MAX_PENDING:]
        if pending and time.time() - last_retry >= RETRY_SECONDS:
            last_retry = time.time()
            pending = retry(pending)

        time.sleep(config.POLL_SECONDS)


def main():
    ap = argparse.ArgumentParser(description="macOS 通知原样转发到 Homing 服务端")
    ap.add_argument("--dump", action="store_true", help="打印最近 5 条通知的原始结构")
    args = ap.parse_args()

    if not os.path.exists(DB):
        sys.exit(f"通知数据库不存在：{DB}\n该 macOS 版本可能换了路径。")
    try:
        records = read_records()
    except (PermissionError, sqlite3.OperationalError) as e:
        sys.exit(f"读不到通知数据库（{e}）\n"
                 f"需要给这个解释器授予「完全磁盘访问权限」：\n"
                 f"  {os.path.realpath(sys.executable)}\n见 mac/README.md「3. 授予完全磁盘访问权限」。")

    if args.dump:
        for d in records[-5:]:
            print(json.dumps(d, indent=2, ensure_ascii=False, default=encode))
            print("-" * 60)
        return
    run()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass

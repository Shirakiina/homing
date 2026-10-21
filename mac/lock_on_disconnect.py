#!/usr/bin/env python3
"""
屏幕共享断开即锁屏 —— 运行在【分机】

监控屏幕共享连接状态，一旦断开立刻关屏。配合 askForPassword=1，
唤醒时需要密码，效果等同锁屏。

为什么不用 CGSession -suspend 这类"真锁屏"命令：
    它会切到登录窗口、让出 console 会话。转发服务是跑在用户会话里的
    LaunchAgent，没必要冒这个险；"关屏 + 要求密码"不动会话，安全等价。
"""

import subprocess
import sys
import time
from datetime import datetime

POLL_SECONDS = 2        # 检测间隔
CONFIRM_TIMES = 2       # 连续 N 次检测到断开才动作，防抖
MARK = "Remote user is connected"

# 无屏幕共享期间，每隔这么久重新关一次屏。设 0 关闭该行为。
#
# 为什么需要它：开机时内置键盘/触控板与 powerd 会各建立一个 UserIsActive 断言，
# 超时长达约 113 分钟，而 displaysleep 是 120 分钟 —— 屏幕会一直亮着。
# 系统事件(唤醒、外设插拔、定时任务)也会零星把屏幕点亮。只做事件触发不够，
# 必须周期性兜底。分机是无头挂机的，持续保证关屏是合理的。
ENFORCE_INTERVAL = 60


def log(msg):
    print(f"{datetime.now():%H:%M:%S}  {msg}", flush=True)


def sharing_connected():
    """屏幕共享是否连接中。VNC 端口检测不可靠，用电源断言判断。"""
    try:
        out = subprocess.run(["pmset", "-g", "assertions"],
                             capture_output=True, text=True, timeout=8).stdout
        return MARK in out
    except Exception as e:
        log(f"[warn] 检测失败: {e}")
        return None            # 未知状态，不触发动作


def lock():
    subprocess.run(["pmset", "displaysleepnow"], check=False)


def password_required():
    """确认唤醒是否需要密码，否则关屏只是关屏、不等于锁屏。"""
    try:
        r = subprocess.run(["defaults", "read", "com.apple.screensaver",
                            "askForPassword"], capture_output=True, text=True)
        return r.stdout.strip() == "1"
    except Exception:
        return False


def main():
    if not password_required():
        log("[warn] askForPassword 未开启 —— 关屏后无需密码即可唤醒，不等于锁屏")
        log("       修复: defaults write com.apple.screensaver askForPassword -int 1")

    prev = sharing_connected()
    log(f"监控启动，当前屏幕共享: {'已连接' if prev else '未连接'}")

    last_lock = 0.0
    # 开机自动登录后没有任何屏幕共享连接，此时必须主动锁屏 ——
    # 只等"断开"事件是不够的，那个事件永远不会发生。
    if not prev:
        log("启动时无屏幕共享 → 立即锁屏")
        lock()
        last_lock = time.time()

    miss = 0
    enforced = 0
    while True:
        time.sleep(POLL_SECONDS)
        now = sharing_connected()
        if now is None:
            continue

        if prev and not now:
            # 疑似断开，连续确认几次避免抖动误判
            miss += 1
            if miss >= CONFIRM_TIMES:
                log("屏幕共享已断开 → 立即锁屏")
                lock()
                last_lock = time.time()
                prev = False
                miss = 0
            continue

        if not prev and now:
            log("屏幕共享已连接")

        miss = 0
        prev = now

        # 兜底：没人连着的时候，周期性把屏幕按回去
        if (not now and ENFORCE_INTERVAL
                and time.time() - last_lock >= ENFORCE_INTERVAL):
            lock()
            last_lock = time.time()
            enforced += 1
            if enforced <= 3 or enforced % 30 == 0:   # 避免日志刷屏
                log(f"周期性保证关屏 (第 {enforced} 次)")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n已停止")

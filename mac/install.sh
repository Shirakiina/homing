#!/usr/bin/env bash
#
# 安装 / 卸载 LaunchAgent，更新代码后重跑一遍即可：
#   ./install.sh              只装通知转发（日常使用的机器）
#   ./install.sh --headless   另装断开屏幕共享即锁屏，并检查自动登录（无头分机）
#   ./install.sh uninstall    卸载
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENTS="$HOME/Library/LaunchAgents"
DB="$HOME/Library/Group Containers/group.com.apple.usernoted/db2/db"
LABELS=(io.github.homing.forward io.github.homing.lock)

ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# framework 版 Python 的 bin/pythonX.Y 只是 stub，TCC 认的是 Python.app 里的
# 二进制；launchd 用 stub 启动会拿不到完全磁盘访问权限（PITFALLS 第 2 条）。
app_binary() {
    local real base
    real=$("$1" -c 'import os,sys;print(os.path.realpath(sys.executable))' 2>/dev/null) || return 1
    base="${real%/bin/*}"
    if [ -x "$base/Resources/Python.app/Contents/MacOS/Python" ]; then
        echo "$base/Resources/Python.app/Contents/MacOS/Python"
    else
        echo "$real"
    fi
}

# 逐个候选实测能否读通知库，而不是信 PATH：SSH 会话的 PATH 常不含
# /opt/homebrew/bin，会挑到没有授权的系统 Python。
pick_python() {
    local c py
    # 显式指定就直接信任：下面的测试在当前 shell 里跑，TCC 按发起进程归属权限，
    # 结果未必和 launchd 启动时一致
    if [ -n "${PYTHON:-}" ]; then
        app_binary "$PYTHON"
        return
    fi
    for c in /opt/homebrew/bin/python3 /usr/local/bin/python3 \
             "$(command -v python3 || true)" /usr/bin/python3; do
        [ -x "$c" ] || continue
        py=$(app_binary "$c") || continue
        if "$py" -c 'import sys; open(sys.argv[1], "rb").read(1)' "$DB" 2>/dev/null; then
            echo "$py"
            return 0
        fi
    done
    return 1
}

install_agent() {   # label 脚本 解释器
    local label=$1 script=$2 py=$3
    local plist="$AGENTS/$label.plist" log="/tmp/homing-${label##*.}.log"
    mkdir -p "$AGENTS"
    # -u 不能省：后台运行时 stdout 是块缓冲，日志不落盘（PITFALLS 第 5 条）
    cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array><string>$py</string><string>-u</string><string>$script</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$log</string>
  <key>StandardErrorPath</key><string>$log</string>
</dict>
</plist>
EOF
    launchctl unload "$plist" 2>/dev/null || true
    launchctl load -w "$plist"
    # 不能写成 `launchctl list | grep -q`：grep -q 匹配后立即退出，launchctl
    # 被 SIGPIPE 杀掉，pipefail 把它当失败，于是越找到越判失败，还时好时坏
    for _ in $(seq 10); do
        sleep 1
        if launchctl list "$label" &>/dev/null; then
            ok "$label 已启动，日志 $log"
            return 0
        fi
    done
    die "$label 未能启动，看日志 $log"
}

case "${1:-}" in
""|--headless)
    [ -f "$REPO/config.py" ] || die "缺少 config.py：cp config.example.py config.py 后填写"
    py=$(pick_python) || die "没有任何 Python 能读通知数据库，先授予完全磁盘访问权限（见 mac/README.md「3. 授予完全磁盘访问权限」）"
    ok "解释器 $py"
    install_agent io.github.homing.forward "$REPO/notify_forward.py" "$py"

    # 锁屏服务只给无头分机：装在日常使用的机器上，它会每分钟锁一次屏
    if [ "${1:-}" = --headless ]; then
        install_agent io.github.homing.lock "$REPO/lock_on_disconnect.py" "$py"
        if [ "$(defaults read com.apple.screensaver askForPassword 2>/dev/null)" = 1 ]; then
            ok "唤醒需要密码"
        else
            warn "唤醒不需要密码，关屏不等于锁屏（见 mac/README.md「1. 系统设置」）"
        fi
        if defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser &>/dev/null; then
            ok "已开启自动登录"
        else
            warn "未开启自动登录，重启后服务不会启动（见 mac/README.md「1. 系统设置」）"
        fi
    fi
    ;;
uninstall)
    for label in "${LABELS[@]}"; do
        launchctl unload "$AGENTS/$label.plist" 2>/dev/null || true
        rm -f "$AGENTS/$label.plist"
        ok "已移除 $label"
    done
    ;;
*)
    sed -n '3,6p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac

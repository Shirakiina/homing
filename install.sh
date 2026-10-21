#!/bin/bash
# 把 Homing 服务端注册为 macOS launchd 常驻服务：开机自启、崩溃自动拉起。
#   ./install.sh            安装 / 更新
#   ./install.sh uninstall  卸载
set -euo pipefail

LABEL="io.github.homing.server"
DIR="$(cd "$(dirname "$0")" && pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="/tmp/homing.log"
DOMAIN="gui/$(id -u)"

if [[ "${1:-}" == "uninstall" ]]; then
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "已卸载"
  exit 0
fi

[[ -f "$DIR/config.py" ]] || { echo "缺少 config.py：cp config.example.py config.py 后再装"; exit 1; }

PY="$(command -v python3)"
PORT="$(cd "$DIR" && "$PY" -c 'import config; print(config.PORT)')"

cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$PY</string><string>-u</string><string>$DIR/server.py</string></array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PL

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST"

# launchd 注册有延迟，轮询而不是 sleep 一下就判死
for _ in $(seq 20); do
  curl -fs "http://127.0.0.1:$PORT/health" >/dev/null && { echo "已启动  http://127.0.0.1:$PORT/"; exit 0; }
  sleep 0.5
done
echo "启动超时，查看日志：tail -50 $LOG"; exit 1

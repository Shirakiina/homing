"""
配置模板：cp config.example.py config.py 后填写。
config.py 含推送 token，已在 .gitignore 中排除。
"""

# Homing 服务端的接收地址（/notify），协议见 README「接口」
RECEIVER = "https://homing.example.com/notify"

# 服务端的推送 token（服务端 config.py 里的 TOKEN），随请求头 X-Token 发送
TOKEN = "change-me"

# 轮询间隔（秒）。通知落库本身有约 10 秒延迟，调小没有意义。
POLL_SECONDS = 2

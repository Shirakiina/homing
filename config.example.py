"""
Homing 配置模板。

    cp config.example.py config.py

每一项都可以用同名环境变量 HOMING_<名字> 覆盖（Docker 部署走这条路），
所以这个文件本身也能直接当 config.py 用。config.py 含密钥，不要入库。
"""

import os

env = os.environ.get

# 监听地址与端口。
HOST = env("HOMING_HOST", "0.0.0.0")
PORT = int(env("HOMING_PORT", "8790"))

# 登录密码。查看界面必须先登录，只需输入这个密码。
# 改密码会让所有已登录的设备立即失效。
PASSWORD = env("HOMING_PASSWORD", "change-me")

# 推送密钥。所有写入接口（/hook/*、/notify）都要带上它，任选一种方式：
#   Header   X-Token: <TOKEN>
#   Header   Authorization: Bearer <TOKEN>
#   Query    ?token=<TOKEN>          ← GitHub 等只能填 URL 的服务用这个
#
# 生成：openssl rand -hex 16
# 用 mac/ 下的 macOS 转发客户端时，它的 config.py 里填同一个 TOKEN。
TOKEN = env("HOMING_TOKEN", "change-me")

# 对外访问地址，用于「接入」面板里生成 webhook 地址。
# 部署在反向代理后面时填域名，例如 https://homing.example.com；本机使用留空。
PUBLIC_URL = env("HOMING_PUBLIC_URL", "")

# 是否信任反向代理传来的客户端 IP（X-Real-IP，用于登录防爆破按 IP 计数）。
# 只有部署在 nginx 后面、且 nginx 设置了 proxy_set_header X-Real-IP $remote_addr 时才打开，
# 否则 IP 可被伪造。
TRUST_PROXY = env("HOMING_TRUST_PROXY", "0") == "1"

# 登录有效期（天）
SESSION_DAYS = int(env("HOMING_SESSION_DAYS", "30"))

# 数据库位置
DB_PATH = env("HOMING_DB_PATH", os.path.expanduser("~/.homing.db"))

# 保留天数。星标消息不受影响。
KEEP_DAYS = int(env("HOMING_KEEP_DAYS", "30"))

# 收到消息时是否弹 macOS 系统通知（仅在 Mac 上运行时有效）。
# Web 界面里也可以单独开启浏览器通知，两者择一即可。
SYSTEM_NOTIFY = env("HOMING_SYSTEM_NOTIFY", "0") == "1"

# ---- AI 整理（可选）----
# OpenAI 兼容接口地址（到 /v1 为止）。留空 = 关闭。
# 开启后每条新消息会在后台交给模型：判断广告/垃圾（只隐藏、不删除）、
# 生成简洁标题和摘要、自动打标签、为未指定级别的消息建议级别。原文始终保留。
# 注意：消息正文会发送到这个地址。
AI_URL = env("HOMING_AI_URL", "")
AI_MODEL = env("HOMING_AI_MODEL", "")      # 留空 = 取接口上的第一个模型
AI_KEY = env("HOMING_AI_KEY", "")          # 自部署服务一般不需要
AI_TIMEOUT = int(env("HOMING_AI_TIMEOUT", "30"))

FROM python:3.12-slim

# 以 uid 1000 运行；数据在 /data（建议挂命名卷，见 docker-compose.yaml）
RUN useradd -u 1000 -m app && mkdir /data && chown app /data
WORKDIR /app
COPY --chown=app adapters.py ai.py server.py ./
COPY --chown=app static ./static
# 配置全部走环境变量（见 config.example.py），模板本身即可当 config.py 用
COPY --chown=app config.example.py ./config.py

USER app
ENV PYTHONUNBUFFERED=1 HOMING_DB_PATH=/data/homing.db
EXPOSE 8790
HEALTHCHECK --interval=30s --timeout=3s \
  CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8790/health',timeout=2)"
CMD ["python", "server.py"]

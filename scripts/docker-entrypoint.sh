#!/bin/sh
# 生产单容器入口：迁移数据库后，同时监管 FastAPI 与 Bun Worker 两个进程。
set -eu

worker_pid=""
api_pid=""

stop_children() {
  trap - TERM INT
  if [ -n "$api_pid" ]; then
    kill -TERM "$api_pid" 2>/dev/null || true
  fi
  if [ -n "$worker_pid" ]; then
    kill -TERM "$worker_pid" 2>/dev/null || true
  fi
  if [ -n "$api_pid" ]; then
    wait "$api_pid" 2>/dev/null || true
  fi
  if [ -n "$worker_pid" ]; then
    wait "$worker_pid" 2>/dev/null || true
  fi
}

trap 'stop_children; exit 0' TERM INT

: "${SANDBOX_WORKER_TOKEN:?必须配置 SANDBOX_WORKER_TOKEN}"

SANDBOX_PORT="${SANDBOX_PORT:-8010}"
SANDBOX_DATA_DIR="${SANDBOX_DATA_DIR:-/app/data/sandbox-worker}"
SANDBOX_TEMPLATE_DIR="${SANDBOX_TEMPLATE_DIR:-/app/templates/vite-react}"

mkdir -p "$SANDBOX_DATA_DIR/jobs" "$SANDBOX_DATA_DIR/previews"

echo "[entrypoint] 应用数据库迁移"
/app/.venv/bin/alembic upgrade head

echo "[entrypoint] 启动沙箱 Worker（127.0.0.1:${SANDBOX_PORT}）"
# Worker 不继承主服务的模型、邮件和数据库密钥；Vite 子进程还会再做白名单过滤。
env -i \
  PATH="/usr/local/bin:/usr/bin:/bin" \
  HOME="/tmp" \
  TMPDIR="/tmp" \
  CI="1" \
  NODE_ENV="production" \
  SANDBOX_HOST="127.0.0.1" \
  SANDBOX_PORT="$SANDBOX_PORT" \
  SANDBOX_DATA_DIR="$SANDBOX_DATA_DIR" \
  SANDBOX_TEMPLATE_DIR="$SANDBOX_TEMPLATE_DIR" \
  SANDBOX_WORKER_TOKEN="$SANDBOX_WORKER_TOKEN" \
  /usr/local/bin/bun /app/sandbox-worker/index.ts &
worker_pid=$!

# API 启动前先确认内部 Worker 可用，避免容器表面存活但所有预览都失败。
attempt=0
until /app/.venv/bin/python -c \
  "import urllib.request; urllib.request.urlopen('http://127.0.0.1:${SANDBOX_PORT}/health', timeout=1)" \
  >/dev/null 2>&1
do
  if ! kill -0 "$worker_pid" 2>/dev/null; then
    echo "[entrypoint] 沙箱 Worker 启动失败" >&2
    wait "$worker_pid"
    exit $?
  fi
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 50 ]; then
    echo "[entrypoint] 沙箱 Worker 健康检查超时" >&2
    stop_children
    exit 1
  fi
  sleep 0.2
done

echo "[entrypoint] 启动 FastAPI（0.0.0.0:8000）"
/app/.venv/bin/uvicorn app.main:app \
  --host 0.0.0.0 \
  --port 8000 \
  --proxy-headers \
  --forwarded-allow-ips='*' &
api_pid=$!

# 任一核心进程退出都结束整个容器，让 restart policy 统一恢复，避免半失效状态。
while kill -0 "$worker_pid" 2>/dev/null && kill -0 "$api_pid" 2>/dev/null; do
  sleep 1
done

exit_code=1
if ! kill -0 "$worker_pid" 2>/dev/null; then
  set +e
  wait "$worker_pid"
  exit_code=$?
  set -e
  echo "[entrypoint] 沙箱 Worker 已退出（${exit_code}）" >&2
else
  set +e
  wait "$api_pid"
  exit_code=$?
  set -e
  echo "[entrypoint] FastAPI 已退出（${exit_code}）" >&2
fi

stop_children
exit "$exit_code"

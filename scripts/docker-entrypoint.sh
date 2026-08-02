#!/bin/sh
# 生产单容器入口：迁移数据库后，同时监管 FastAPI 与 Node Worker 两个进程。
set -eu
umask 077

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
SANDBOX_DATA_DIR="${SANDBOX_DATA_DIR:-/app/sandbox-data}"
SANDBOX_TEMPLATE_DIR="${SANDBOX_TEMPLATE_DIR:-/app/templates/vite-react}"
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/ms-playwright}"
sandbox_run_uid=10001
sandbox_run_gid=10001
storage_repair_flag=""

# 容器 root 只保留 CHOWN/SETUID/SETGID/KILL 四项能力，不具备 DAC 权限；KILL 仅用于
# 监管已经降到 UID 10001 的 Worker 子进程。目录缺少权限时，
# SQLite 可能仍能读取旧数据，却会在创建会话时才暴露 readonly database。
# 在启动前直接失败，避免出现“健康检查正常、业务写请求 500”的半失效状态。
if [ ! -w /app/data ] || [ ! -x /app/data ]; then
  echo "[entrypoint] 数据目录 /app/data 不可写或不可进入，请检查宿主机挂载目录权限" >&2
  exit 1
fi
case "$SANDBOX_DATA_DIR" in
  /app/sandbox-data | /app/sandbox-data/*) ;;
  /app/data/sandbox-worker | /app/data/sandbox-worker/*)
    # 兼容只切镜像标签的旧部署：Compose 可暂时保留旧环境变量，同时把同一个
    # 宿主子目录额外挂到 /app/sandbox-data。新 Worker 必须从独立挂载点进入，
    # 否则 UID 10001 会被数据库卷根目录的 0700 权限拦住。
    sandbox_relative_path="${SANDBOX_DATA_DIR#/app/data/sandbox-worker}"
    SANDBOX_DATA_DIR="/app/sandbox-data${sandbox_relative_path}"
    export SANDBOX_DATA_DIR
    echo "[entrypoint] 将旧沙箱路径映射到独立挂载点 ${SANDBOX_DATA_DIR}"
    ;;
  *)
    echo "[entrypoint] SANDBOX_DATA_DIR 必须位于 /app/sandbox-data 或兼容路径 /app/data/sandbox-worker 内" >&2
    exit 1
    ;;
esac

case "${SANDBOX_FORCE_STORAGE_REPAIR:-0}" in
  0 | "") ;;
  1)
    # 从旧 root Worker 回滚后，marker 仍可能存在，但旧进程会新增 root 所有的深层产物。
    # 过渡部署强制重扫一次，避免下次前进部署只校正顶层 inode 而留下不可访问缓存。
    storage_repair_flag="--force"
    echo "[entrypoint] 强制复核沙箱存储权限"
    ;;
  *)
    echo "[entrypoint] SANDBOX_FORCE_STORAGE_REPAIR 只能为 0 或 1" >&2
    exit 1
    ;;
esac

# API 仍由容器 root 管理数据库；Worker 与 Chromium 降为固定无特权 UID，只拥有沙箱目录。
# 即使浏览器进程异常，也不能直接读取 SQLite、模型配置或主服务运行态。
#
# root 没有 DAC/FOWNER，旧版或中断迁移不能靠普通 chown -R 自愈。辅助脚本用 CAP_CHOWN
# 逐层接管后再后序交权，并仅在完整成功后写 marker；正常重启只校正三个顶层 inode。
/app/.venv/bin/python /app/scripts/prepare_sandbox_storage.py \
  "$SANDBOX_DATA_DIR" "$sandbox_run_uid" "$sandbox_run_gid" $storage_repair_flag
for database_file in \
  /app/data/xiaozhu.db \
  /app/data/xiaozhu.db-shm \
  /app/data/xiaozhu.db-wal
do
  if [ -e "$database_file" ]; then
    chmod 600 "$database_file"
  fi
done

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
  SANDBOX_BUILD_TIMEOUT_MS="60000" \
  SANDBOX_CAPTURE_TIMEOUT_MS="12000" \
  SANDBOX_RUN_UID="$sandbox_run_uid" \
  SANDBOX_RUN_GID="$sandbox_run_gid" \
  PLAYWRIGHT_BROWSERS_PATH="$PLAYWRIGHT_BROWSERS_PATH" \
  /usr/local/bin/node /app/sandbox-worker/index.js &
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

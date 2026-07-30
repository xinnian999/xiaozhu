#!/usr/bin/env sh
# Vite 一旦开始监听，浏览器会立刻重连并请求登录态与会话。若 FastAPI 仍在迁移或
# Worker 尚未监听，这些首屏请求会失败并把页面留在错误状态，所以先等待两个后端健康。
set -eu

api_url="${DEV_API_HEALTH_URL:-http://127.0.0.1:7200/api/setup-status}"
worker_url="${DEV_WORKER_HEALTH_URL:-http://127.0.0.1:7010/health}"
max_attempts="${DEV_HEALTH_MAX_ATTEMPTS:-240}"
attempt=0

if ! command -v curl >/dev/null 2>&1; then
  echo "[dev-ready] 缺少 curl，无法等待开发服务就绪。" >&2
  exit 1
fi

while [ "$attempt" -lt "$max_attempts" ]; do
  if curl --fail --silent --show-error --max-time 1 "$api_url" >/dev/null 2>&1 \
    && curl --fail --silent --show-error --max-time 1 "$worker_url" >/dev/null 2>&1; then
    echo "[dev-ready] API 与沙箱 Worker 已就绪。"
    exit 0
  fi
  sleep 0.25
  attempt=$((attempt + 1))
done

echo "[dev-ready] 等待 API 或沙箱 Worker 超时，拒绝启动前端。" >&2
exit 1

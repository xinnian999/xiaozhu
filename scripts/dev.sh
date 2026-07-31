#!/usr/bin/env sh
# 一条命令启动本地完整开发环境。这里的默认密钥仅用于 loopback 开发服务；
# 外部环境传入同名变量时始终优先使用外部配置。
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

export SANDBOX_WORKER_TOKEN="${SANDBOX_WORKER_TOKEN:-xiaozhu-local-dev-worker-token}"
export SANDBOX_CAPABILITY_SECRET="${SANDBOX_CAPABILITY_SECRET:-xiaozhu-local-dev-capability-secret}"
export SANDBOX_WORKER_URL="${SANDBOX_WORKER_URL:-http://127.0.0.1:7010}"
export SANDBOX_PREVIEW_DIR="${SANDBOX_PREVIEW_DIR:-$project_dir/data/sandbox-worker-dev/previews}"
export SANDBOX_PREVIEW_ORIGIN="${SANDBOX_PREVIEW_ORIGIN:-http://preview.localhost:7300}"
# 本地 Chrome、扩展调试和桌面 WebView 可能在顶层页面外再套一层祖先；严格写死
# localhost:7300 会让浏览器偶发拒绝嵌入，但生产仍由部署环境显式配置真实主站域名。
export SANDBOX_FRAME_ANCESTORS="${SANDBOX_FRAME_ANCESTORS:-*}"

exec pnpm exec concurrently \
  -k \
  -n web,admin,server,sandbox \
  -c cyan,yellow,magenta,green \
  "pnpm run dev:web" \
  "pnpm run dev:admin" \
  "pnpm run dev:server" \
  "pnpm run dev:sandbox"

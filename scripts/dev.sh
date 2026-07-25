#!/usr/bin/env sh
# 一条命令启动本地完整开发环境。这里的默认密钥仅用于 loopback 开发服务；
# 外部环境传入同名变量时始终优先使用外部配置。
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

export SANDBOX_WORKER_TOKEN="${SANDBOX_WORKER_TOKEN:-xiaozhu-local-dev-worker-token}"
export SANDBOX_CAPABILITY_SECRET="${SANDBOX_CAPABILITY_SECRET:-xiaozhu-local-dev-capability-secret}"
export SANDBOX_WORKER_URL="${SANDBOX_WORKER_URL:-http://127.0.0.1:8010}"
export SANDBOX_PREVIEW_DIR="${SANDBOX_PREVIEW_DIR:-$project_dir/data/sandbox-worker-dev/previews}"
export SANDBOX_PREVIEW_ORIGIN="${SANDBOX_PREVIEW_ORIGIN:-http://preview.localhost:9000}"
export SANDBOX_FRAME_ANCESTORS="${SANDBOX_FRAME_ANCESTORS:-http://localhost:9000}"

exec pnpm exec concurrently \
  -k \
  -n web,admin,server,sandbox \
  -c cyan,yellow,magenta,green \
  "pnpm run dev:web" \
  "pnpm run dev:admin" \
  "pnpm run dev:server" \
  "pnpm run dev:sandbox"

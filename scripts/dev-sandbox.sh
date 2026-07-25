#!/usr/bin/env sh
# 本地开发不要求 Docker：首次启动时安装固定预览模板依赖，之后直接复用。
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
template_dir="$project_dir/server/templates/vite-react"
data_dir="$project_dir/data/sandbox-worker-dev"

if [ ! -x "$template_dir/node_modules/.bin/vite" ]; then
  echo "[sandbox] 首次启动，正在安装固定预览模板依赖…"
  bun install --cwd "$template_dir" --no-save
fi

mkdir -p "$data_dir"

export SANDBOX_PORT="${SANDBOX_PORT:-8010}"
export SANDBOX_DATA_DIR="${SANDBOX_DATA_DIR:-$data_dir}"
export SANDBOX_TEMPLATE_DIR="${SANDBOX_TEMPLATE_DIR:-$template_dir}"

echo "[sandbox] Worker 已启动：http://127.0.0.1:$SANDBOX_PORT"
exec bun run "$project_dir/sandbox-worker/index.ts"

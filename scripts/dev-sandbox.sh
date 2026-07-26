#!/usr/bin/env sh
# 本地开发不要求 Docker：首次启动时安装固定预览模板依赖，之后直接复用。
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
template_dir="$project_dir/server/templates/vite-react"
data_dir="$project_dir/data/sandbox-worker-dev"

if [ ! -x "$template_dir/node_modules/.bin/vite" ]; then
  echo "[sandbox] 首次启动，正在安装固定预览模板依赖…"
  pnpm --dir "$template_dir" install --frozen-lockfile --ignore-workspace
fi

mkdir -p "$data_dir"

export SANDBOX_PORT="${SANDBOX_PORT:-8010}"
export SANDBOX_DATA_DIR="${SANDBOX_DATA_DIR:-$data_dir}"
export SANDBOX_TEMPLATE_DIR="${SANDBOX_TEMPLATE_DIR:-$template_dir}"

if command -v lsof >/dev/null 2>&1; then
  lsof_bin=$(command -v lsof)
elif [ -x /usr/sbin/lsof ]; then
  lsof_bin=/usr/sbin/lsof
else
  echo "[sandbox] 缺少 lsof，无法确认 Worker 端口是否可用。" >&2
  exit 1
fi

if "$lsof_bin" -nP -tiTCP:"$SANDBOX_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "[sandbox] 端口 $SANDBOX_PORT 已被占用，拒绝启动等待态 Worker。" >&2
  exit 1
fi

echo "[sandbox] Worker 已启动：http://127.0.0.1:$SANDBOX_PORT"
# 开发期 bridge 也会频繁调整；监听源码变化后自动重启，避免前端已热更新而 Worker
# 仍持续产出旧版预览脚本，造成只能整组重启才能验证的假象。
exec node --watch "$project_dir/sandbox-worker/index.ts"

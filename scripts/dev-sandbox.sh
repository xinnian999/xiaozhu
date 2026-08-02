#!/usr/bin/env sh
# 本地开发不要求 Docker：固定预览模板依赖变化时自动同步，未变化则直接复用。
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
template_dir="$project_dir/server/templates/vite-react"
data_dir="$project_dir/data/sandbox-worker-dev"
dependencies_stamp="$template_dir/node_modules/.xiaozhu-dependencies-fingerprint"
installed_lockfile="$template_dir/node_modules/.pnpm/lock.yaml"
# package.json 与锁文件必须一起纳入指纹：只改其中一个时也应重新执行 frozen install，
# 让 pnpm 明确报告清单不一致，而不是继续复用一份看似可用的陈旧 node_modules。
dependencies_fingerprint="$(cksum < "$template_dir/package.json"):$(cksum < "$template_dir/pnpm-lock.yaml")"
installed_fingerprint=""

if [ -f "$dependencies_stamp" ]; then
  installed_fingerprint=$(cat "$dependencies_stamp")
fi

if [ ! -x "$template_dir/node_modules/.bin/vite" ] \
  || ! cmp -s "$template_dir/pnpm-lock.yaml" "$installed_lockfile" \
  || [ "$installed_fingerprint" != "$dependencies_fingerprint" ]; then
  echo "[sandbox] 预览模板依赖缺失或已变化，正在同步…"
  # concurrently、CI 与桌面启动都可能没有交互式 TTY；显式开启 CI 模式，允许 pnpm
  # 在安装态不兼容时重建 node_modules，而不是等待无法完成的确认。
  CI=1 pnpm --dir "$template_dir" install --frozen-lockfile --ignore-workspace
  # 仅在安装成功后记录指纹；安装中断时下次启动会继续重试。
  printf '%s\n' "$dependencies_fingerprint" > "$dependencies_stamp"
fi

# Playwright npm 包不自动下载浏览器；开发机首次启动时补齐 Chromium，之后命中本地缓存。
# 显式 executablePath 由测试/自定义环境自行负责，不再触发默认浏览器安装。
if [ -z "${SANDBOX_CHROMIUM_EXECUTABLE_PATH:-}" ]; then
  browser_path=$(CDPATH= cd -- "$project_dir/sandbox-worker" \
    && node -e 'const { chromium } = require("playwright"); process.stdout.write(chromium.executablePath())')
  if [ ! -x "$browser_path" ]; then
    echo "[sandbox] Playwright Chromium 缺失，正在安装…"
    pnpm --dir "$project_dir/sandbox-worker" exec playwright install chromium
  fi
fi

mkdir -p "$data_dir"

export SANDBOX_PORT="${SANDBOX_PORT:-7010}"
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

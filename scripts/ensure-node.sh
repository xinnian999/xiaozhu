#!/usr/bin/env sh
# nvm 是 shell 函数，并不保证出现在非交互式 pnpm 脚本中。这里直接校验当前运行时，
# 避免误调用 npm 里同名的 nvm 可执行文件，同时给出可操作的版本切换提示。
set -eu

if ! command -v node >/dev/null 2>&1; then
  echo "[node-check] 未找到 Node.js，请先安装并切换到 Node.js 22。" >&2
  exit 1
fi

node_major=$(node -p "process.versions.node.split('.')[0]")
if [ "$node_major" != "22" ]; then
  echo "[node-check] 当前 Node.js 为 $(node -v)，本项目要求 Node.js 22。" >&2
  echo "[node-check] 请先执行 nvm use（或用其他版本管理器切换），再运行 pnpm dev。" >&2
  exit 1
fi

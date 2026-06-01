#!/usr/bin/env bash
#
# 把 Dockerfile 用到的 3 个外部基础镜像，备份一份到阿里云个人镜像仓库。
# 做法就是 Docker 镜像搬运的标准三步：pull（拉官方）→ tag（打私有标签）→ push（推私有库）。
#
# 用法：
#   ./scripts/push-images.sh
#
# 前置条件：
#   1. 已 docker login 到阿里云（脚本会提示你登录，见下方 LOGIN 说明）
#   2. 阿里云命名空间 elin-common 已开启「自动创建仓库」，或已手动建好
#      bun / python / uv 这三个仓库。

set -euo pipefail

# ── 阿里云个人版仓库地址（命名空间：elin-common）──────────────────
REGISTRY="crpi-a7p27yxlrmekg1a3.cn-beijing.personal.cr.aliyuncs.com"
NAMESPACE="elin-common"

# ── 镜像映射表：每行「官方源 => 阿里云仓库名:tag」──────────────────
# 注意：阿里云个人版一个「仓库名」对应一个镜像，所以这里把 oven/bun 简化成 bun，
#       astral-sh/uv 简化成 uv，避免私有库里出现多级路径。
declare -a IMAGES=(
  "oven/bun:1|bun:1"
  "python:3.12-slim|python:3.12-slim"
  "ghcr.io/astral-sh/uv:latest|uv:latest"
)

# ── 登录提示 ─────────────────────────────────────────────────────
# 阿里云个人版登录：用户名是你的阿里云账号全名，密码是「容器镜像服务 → 访问凭证」里
# 设置的固定密码（不是阿里云登录密码）。先执行一次：
#   docker login --username=<你的阿里云账号> "$REGISTRY"
echo "==> 目标仓库：$REGISTRY/$NAMESPACE"
echo "==> 若尚未登录，请先执行： docker login --username=<阿里云账号> $REGISTRY"
echo ""

for entry in "${IMAGES[@]}"; do
  SRC="${entry%%|*}"          # 竖线左边：官方源镜像
  DST_NAME="${entry##*|}"     # 竖线右边：阿里云仓库名:tag
  DST="$REGISTRY/$NAMESPACE/$DST_NAME"

  echo "────────────────────────────────────────────────────────"
  echo "[1/3] pull  $SRC"
  # --platform 强制拉 linux/amd64：本机若是 Apple Silicon(arm64)，
  # 不指定会拉 arm64 版，推到服务器(amd64)上跑不起来。
  docker pull --platform linux/amd64 "$SRC"

  echo "[2/3] tag   $SRC  ->  $DST"
  docker tag "$SRC" "$DST"

  echo "[3/3] push  $DST"
  docker push "$DST"
  echo "✓ 完成：$DST"
  echo ""
done

echo "全部镜像已备份到阿里云：$REGISTRY/$NAMESPACE"

#!/bin/sh

set -eu

# ACR 的内置规则只匹配 release-v$version，并把镜像标记为 $version。
# 这个脚本统一校验发版前置条件，避免从脏工作区、错误分支或未推送提交打标签。

# pnpm 会把 `pnpm release:tag -- 1.2.3` 中的分隔符继续传给 shell 脚本。
if [ "${1:-}" = "--" ]; then
  shift
fi

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
  echo "用法：pnpm release:tag -- <版本>"
  echo "示例：pnpm release:tag -- 2026.07.27-1"
  exit 1
fi

case "$VERSION" in
  *[!0-9A-Za-z._-]* | -* | *-)
    echo "版本格式无效：$VERSION"
    echo "只允许字母、数字、点、下划线和短横线，且不能以短横线开头或结尾。"
    exit 1
    ;;
esac

TAG="release-v$VERSION"
BRANCH="$(git branch --show-current)"

if [ "$BRANCH" != "master" ]; then
  echo "只能从 master 发版，当前分支：$BRANCH"
  exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "工作区存在未提交改动，请先提交或清理后再发版。"
  exit 1
fi

echo "同步远端 master 与标签..."
git fetch origin master --tags

LOCAL_SHA="$(git rev-parse HEAD)"
REMOTE_SHA="$(git rev-parse origin/master)"
if [ "$LOCAL_SHA" != "$REMOTE_SHA" ]; then
  echo "本地 master 与 origin/master 不一致，拒绝发版。"
  echo "本地：$LOCAL_SHA"
  echo "远端：$REMOTE_SHA"
  exit 1
fi

if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  echo "标签已存在：$TAG"
  exit 1
fi

echo "创建并推送发布标签：$TAG"
git tag -a "$TAG" -m "release: $VERSION"
git push origin "$TAG"

echo "标签已推送。ACR 将构建镜像："
echo "crpi-a7p27yxlrmekg1a3.cn-beijing.personal.cr.aliyuncs.com/elin/xiaozhu:$VERSION"
echo "镜像构建成功后，将生产环境 XIAOZHU_IMAGE_TAG 更新为 $VERSION 再重建容器。"

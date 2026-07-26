#!/usr/bin/env bash

set -euo pipefail

TAG="${1:-}"
DIGEST="${2:-}"
COMPOSE_DIR="/www/server/panel/data/compose/xiaozhu"
ENV_FILE="$COMPOSE_DIR/.env"
SERVICE="xiaozhu"
IMAGE_REPOSITORY="crpi-a7p27yxlrmekg1a3.cn-beijing.personal.cr.aliyuncs.com/elin/xiaozhu"
LOG_FILE="/var/log/xiaozhu-deploy.log"
HEALTH_TIMEOUT_SECONDS=150

if [[ ! "$TAG" =~ ^[0-9][0-9A-Za-z._-]*$ ]]; then
  echo "拒绝部署非法镜像标签：$TAG" >&2
  exit 2
fi
if [[ -n "$DIGEST" && ! "$DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "拒绝部署非法镜像摘要" >&2
  exit 2
fi
if [[ ! -f "$ENV_FILE" ]]; then
  echo "生产环境配置不存在：$ENV_FILE" >&2
  exit 2
fi

read_current_tag() {
  sed -n 's/^XIAOZHU_IMAGE_TAG=//p' "$ENV_FILE" | tail -n 1
}

write_image_tag() {
  local next_tag="$1"
  local temporary_file
  temporary_file="$(mktemp "$COMPOSE_DIR/.env.xiaozhu-tag.XXXXXX")"

  awk -v tag="$next_tag" '
    BEGIN { replaced = 0 }
    /^XIAOZHU_IMAGE_TAG=/ {
      if (!replaced) {
        print "XIAOZHU_IMAGE_TAG=" tag
        replaced = 1
      }
      next
    }
    { print }
    END {
      if (!replaced) {
        print "XIAOZHU_IMAGE_TAG=" tag
      }
    }
  ' "$ENV_FILE" > "$temporary_file"

  chmod --reference="$ENV_FILE" "$temporary_file"
  chown --reference="$ENV_FILE" "$temporary_file"
  mv "$temporary_file" "$ENV_FILE"
}

wait_until_healthy() {
  local deadline=$((SECONDS + HEALTH_TIMEOUT_SECONDS))
  local status=""

  while (( SECONDS < deadline )); do
    status="$(
      docker inspect "$SERVICE" \
        --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
        2>/dev/null || true
    )"
    if [[ "$status" == "healthy" ]]; then
      return 0
    fi
    if [[ "$status" == "exited" || "$status" == "dead" ]]; then
      return 1
    fi
    sleep 3
  done

  echo "等待健康状态超时，最后状态：${status:-unknown}"
  return 1
}

deploy_tag() {
  local target_tag="$1"

  write_image_tag "$target_tag" || return 1
  docker compose pull "$SERVICE" || return 1
  docker compose up -d --force-recreate --no-deps "$SERVICE" || return 1
  wait_until_healthy
}

{
  echo "===== $(date -Is) deploy start tag=$TAG digest=${DIGEST:-unknown} ====="
  cd "$COMPOSE_DIR"

  CURRENT_TAG="$(read_current_tag)"
  if [[ -z "$CURRENT_TAG" ]]; then
    echo "当前 XIAOZHU_IMAGE_TAG 为空，拒绝自动部署"
    exit 2
  fi

  TARGET_IMAGE="$IMAGE_REPOSITORY:$TAG"
  RUNNING_IMAGE="$(docker inspect "$SERVICE" --format '{{.Config.Image}}' 2>/dev/null || true)"
  HEALTH_STATUS="$(
    docker inspect "$SERVICE" \
      --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
      2>/dev/null || true
  )"

  if [[ "$CURRENT_TAG" == "$TAG" \
    && "$RUNNING_IMAGE" == "$TARGET_IMAGE" \
    && "$HEALTH_STATUS" == "healthy" ]]; then
    echo "版本 $TAG 已在健康运行，无需重复部署"
    exit 0
  fi

  if deploy_tag "$TAG"; then
    docker image prune -f
    docker compose ps "$SERVICE"
    echo "===== $(date -Is) deploy done tag=$TAG ====="
    exit 0
  fi

  echo "版本 $TAG 部署失败，开始回滚到 $CURRENT_TAG"
  write_image_tag "$CURRENT_TAG"
  if docker compose up -d --force-recreate --no-deps "$SERVICE" \
    && wait_until_healthy; then
    echo "已回滚到 $CURRENT_TAG"
  else
    echo "严重：自动回滚到 $CURRENT_TAG 失败"
  fi
  docker compose ps "$SERVICE" || true
  echo "===== $(date -Is) deploy failed tag=$TAG previous=$CURRENT_TAG ====="
  exit 1
} >> "$LOG_FILE" 2>&1

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

read_sandbox_bind_source() {
  local data_mount
  local data_source
  local expected_source
  local sandbox_mount
  local sandbox_source
  data_mount="$(
    docker inspect "$SERVICE" \
      --format '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{.Type}}|{{.Source}}{{end}}{{end}}' \
      2>/dev/null || true
  )"
  sandbox_mount="$(
    docker inspect "$SERVICE" \
      --format '{{range .Mounts}}{{if eq .Destination "/app/sandbox-data"}}{{.Type}}|{{.Source}}{{end}}{{end}}' \
      2>/dev/null || true
  )"
  [[ "$data_mount" == bind\|/* && "$sandbox_mount" == bind\|/* ]] || return 1
  data_source="${data_mount#bind|}"
  sandbox_source="${sandbox_mount#bind|}"
  [[ -d "$data_source" && ! -L "$data_source" \
    && -d "$sandbox_source" && ! -L "$sandbox_source" ]] || return 1
  expected_source="$data_source/sandbox-worker"
  [[ "$(readlink -f -- "$sandbox_source")" == "$(readlink -f -- "$expected_source")" ]] \
    || return 1
  printf '%s\n' "$sandbox_source"
}

restore_legacy_sandbox_storage() {
  local sandbox_storage_dir="$1"
  # 候选镜像可能已把缓存交给 UID 10001；旧 root Worker 又没有 DAC_OVERRIDE。
  # 回滚前用失败候选镜像里的受审脚本做一次短命、无网络、只挂沙箱目录的权限恢复。
  if ! docker image inspect "$TARGET_IMAGE" >/dev/null 2>&1; then
    echo "候选镜像尚未落盘，跳过旧沙箱权限恢复"
    return 0
  fi
  if [[ -z "$sandbox_storage_dir" || ! -d "$sandbox_storage_dir" \
    || -L "$sandbox_storage_dir" ]]; then
    echo "无法从容器挂载解析可信沙箱目录，拒绝执行权限恢复"
    return 1
  fi

  docker run --rm \
    --user 0:0 \
    --network none \
    --read-only \
    --tmpfs /tmp:size=16m,mode=1777 \
    --memory 128m \
    --cpus 0.5 \
    --pids-limit 32 \
    --cap-drop ALL \
    --cap-add CHOWN \
    --cap-add DAC_OVERRIDE \
    --cap-add FOWNER \
    --security-opt no-new-privileges:true \
    --volume "$sandbox_storage_dir:/app/sandbox-data" \
    --entrypoint /app/.venv/bin/python \
    "$TARGET_IMAGE" \
    /app/scripts/restore_legacy_sandbox_storage.py /app/sandbox-data
}

stop_failed_candidate() {
  # 权限恢复期间绝不能让失败候选继续写同一个卷；否则恢复结束后仍可能产生
  # UID 10001 文件，令旧 Worker 表面 healthy、实际构建失败。
  if ! docker inspect "$SERVICE" >/dev/null 2>&1; then
    return 0
  fi
  docker stop --timeout 20 "$SERVICE" >/dev/null || return 1
  [[ "$(docker inspect "$SERVICE" --format '{{.State.Running}}')" == "false" ]]
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
  ORIGINAL_CONTAINER_ID="$(
    docker inspect "$SERVICE" --format '{{.Id}}' 2>/dev/null || true
  )"
  ORIGINAL_SANDBOX_STORAGE_DIR="$(read_sandbox_bind_source || true)"
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
  FAILED_CONTAINER_ID="$(
    docker inspect "$SERVICE" --format '{{.Id}}' 2>/dev/null || true
  )"
  FAILED_SANDBOX_STORAGE_DIR="$(read_sandbox_bind_source || true)"
  ROLLBACK_SUCCEEDED=0

  if [[ -n "$ORIGINAL_CONTAINER_ID" \
    && "$FAILED_CONTAINER_ID" == "$ORIGINAL_CONTAINER_ID" ]]; then
    echo "候选尚未替换原容器，无需停止服务或恢复沙箱权限"
    if [[ "$(docker inspect "$SERVICE" --format '{{.State.Running}}')" == "true" ]] \
      || docker start "$SERVICE" >/dev/null; then
      if wait_until_healthy; then
        ROLLBACK_SUCCEEDED=1
      fi
    fi
  else
    SANDBOX_STORAGE_DIR="${FAILED_SANDBOX_STORAGE_DIR:-$ORIGINAL_SANDBOX_STORAGE_DIR}"
    if stop_failed_candidate \
      && restore_legacy_sandbox_storage "$SANDBOX_STORAGE_DIR" \
      && docker compose up -d --force-recreate --no-deps "$SERVICE" \
      && wait_until_healthy; then
      ROLLBACK_SUCCEEDED=1
    fi
  fi

  if [[ "$ROLLBACK_SUCCEEDED" == "1" ]]; then
    echo "已回滚到 $CURRENT_TAG"
  else
    echo "严重：自动回滚到 $CURRENT_TAG 失败"
  fi
  docker compose ps "$SERVICE" || true
  echo "===== $(date -Is) deploy failed tag=$TAG previous=$CURRENT_TAG ====="
  exit 1
} >> "$LOG_FILE" 2>&1

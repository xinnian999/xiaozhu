#!/usr/bin/env sh
# 启动 dev 前清理本仓库遗留的完整监督进程树。
#
# 只杀监听子进程不够：FastAPI reloader、Node --watch、pnpm/concurrently 父进程会立即
# 把它们重新拉起，导致新 Vite 偷跑到 9001、API/Worker 却仍是旧进程。这里先用监听
# 端口定位进程，再校验 cwd 确实属于本仓库，最后终止其整个进程组。
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
current_pgid=$(ps -o pgid= -p $$ | tr -d ' ')
ports="9200 8010 9000 9100"
old_pgids=""

if command -v lsof >/dev/null 2>&1; then
  lsof_bin=$(command -v lsof)
elif [ -x /usr/sbin/lsof ]; then
  # Codex、IDE 等启动器可能给出精简 PATH；macOS 的 lsof 固定在 /usr/sbin。
  lsof_bin=/usr/sbin/lsof
else
  echo "[predev-clean] 缺少 lsof，无法安全确认开发端口归属。" >&2
  exit 1
fi

process_cwd() {
  "$lsof_bin" -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1
}

for port in $ports; do
  pids=$("$lsof_bin" -nP -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)
  for pid in $pids; do
    cwd=$(process_cwd "$pid")
    case "$cwd" in
      "$project_dir"|"$project_dir"/*)
        ;;
      *)
        # 变量后紧跟中文标点时必须显式加花括号。macOS 自带 Bash 3.2 在部分
        # UTF-8 locale 下会把标点的首字节误并入变量名，配合 set -u 就会报未绑定变量。
        echo "[predev-clean] 端口 ${port} 被非本项目进程占用（PID ${pid}，cwd=${cwd:-未知}）" >&2
        echo "[predev-clean] 为避免误杀，已中止启动。" >&2
        exit 1
        ;;
    esac

    pgid=$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')
    if [ -z "$pgid" ] || [ "$pgid" = "$current_pgid" ]; then
      echo "[predev-clean] 无法安全清理端口 ${port} 的进程组（PID ${pid}）" >&2
      exit 1
    fi
    case " $old_pgids " in
      *" $pgid "*) ;;
      *) old_pgids="$old_pgids $pgid" ;;
    esac
  done
done

for pgid in $old_pgids; do
  echo "[predev-clean] 结束本项目旧 dev 进程组: $pgid"
  kill -TERM -- "-$pgid" 2>/dev/null || true
done

# 给 concurrently/reloader 一点时间做协同退出；仍残留时再强制结束同一个已校验进程组。
attempt=0
while [ "$attempt" -lt 40 ]; do
  occupied=""
  for port in $ports; do
    if "$lsof_bin" -nP -tiTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
      occupied="$occupied $port"
    fi
  done
  [ -z "$occupied" ] && break
  sleep 0.05
  attempt=$((attempt + 1))
done

if [ -n "$old_pgids" ]; then
  for pgid in $old_pgids; do
    kill -KILL -- "-$pgid" 2>/dev/null || true
  done
fi

for port in $ports; do
  if "$lsof_bin" -nP -tiTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "[predev-clean] 端口 $port 清理后仍被占用，拒绝以错误端口启动。" >&2
    exit 1
  fi
done

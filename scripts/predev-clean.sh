#!/usr/bin/env sh
# 启动 dev 前先释放端口：杀掉上一次没退干净的残留后端/前端进程。
#
# 为什么需要它：`fastapi dev` 是「reloader 父进程 + worker 子进程」的进程树，
# 如果直接关终端、或上次 dev 没用 Ctrl+C 正常退出，子进程会变孤儿继续占着 :8000，
# 还 pin 住当时打开的 SQLite 文件 —— 于是出现「改了库/迁移了却不生效、数据对不上」的灵异现象。
# 每次启动前清一遍，僵尸就自愈了，不用再手动 lsof。
#
# 只杀本机 dev 用的端口；杀不到（本来就没残留）也静默通过。
# 8000=后端 fastapi，9000=前台 vite，9100=管理后台 vite（web-admin）。
for port in 8000 9000 9100; do
  pids=$(lsof -ti :"$port" 2>/dev/null)
  if [ -n "$pids" ]; then
    echo "[predev-clean] 释放端口 $port，结束残留进程: $pids"
    # shellcheck disable=SC2086
    kill -9 $pids 2>/dev/null
  fi
done
exit 0

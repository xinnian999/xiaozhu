"""浏览器日志的内存暂存。

为什么放内存、不进数据库？
  - 这些日志是「预览跑起来时的 console 输出」，高频、瞬时、只在「写完代码→
    检查有没有报错」这一小段时间内有用。修完就没价值了。
  - 存数据库要建表、要 commit，又得清理过期数据，得不偿失。
  - 所以用一个模块级的字典当缓存：进程活着就在，重启就没——完全够用。

谁写、谁读？
  - 写：前端通过 POST /api/sessions/{id}/logs 把 wcLogs 推过来（api/logs.py）。
  - 读：chat.py 里的 get_browser_logs 工具，agent 写完代码后调用它查报错。

时序难点（核心）：
  agent 写完文件会「立刻」调 get_browser_logs，但那一刻浏览器的 HMR 可能还没
  跑完、错误还没产生。怎么知道「现在拿到的日志是不是这次写入引发的」？
  靠时间戳不行——前端是浏览器时钟、后端是服务器时钟，两者不同步。
  解法：给每条日志打一个「单调递增的序号 seq」，写文件时记下当时的 seq 当
  「屏障」。序号 ≥ 屏障的日志，才是这次写入之后才产生的。get_browser_logs
  就等这种「屏障之后的新日志」出现（或超时）。

注意：内存字典是「整个进程共享」的全局状态。单机、单进程的学习项目没问题；
将来要多进程部署（gunicorn 多 worker）就得换成 Redis 之类的共享存储——先不管。
"""

from collections import defaultdict, deque
from dataclasses import dataclass

from pydantic import BaseModel

# 每个 session 最多保留多少条日志。预览报错往往是同一条错误反复刷（HMR 每次
# 重连都打一遍），留太多没意义，够 agent 看清最近发生了什么就行。
_MAX_LOGS_PER_SESSION = 50


class BrowserLog(BaseModel):
    """一条浏览器日志。字段和前端 wcLogs 的 LogEntry 对齐。"""

    level: str  # 'log' | 'info' | 'warn' | 'error'
    text: str
    ts: int  # 前端打这条日志的时间戳（毫秒）。仅做展示用，时序判断不靠它。


@dataclass
class _Entry:
    """store 内部条目：在前端日志外面套一个后端分配的序号 seq。"""

    seq: int
    log: BrowserLog


# session_id -> 最近若干条日志。deque(maxlen=N) 自带「超长自动丢最旧」。
_store: dict[str, deque[_Entry]] = defaultdict(
    lambda: deque(maxlen=_MAX_LOGS_PER_SESSION)
)
# session_id -> 下一个要分配的序号（单调递增，永不回退，即使日志被 deque 挤掉）。
_next_seq: dict[str, int] = defaultdict(int)
# session_id -> 屏障序号。write_file 时设为「当前 _next_seq」，
# 之后 seq >= 屏障 的日志，就是这次写入之后才产生的。
_barrier: dict[str, int] = defaultdict(int)


def append_logs(session_id: str, logs: list[BrowserLog]) -> None:
    """把前端推来的一批日志追加到该 session 的缓存里，逐条分配递增序号。"""
    for log in logs:
        seq = _next_seq[session_id]
        _next_seq[session_id] = seq + 1
        _store[session_id].append(_Entry(seq=seq, log=log))


def mark_write(session_id: str) -> None:
    """记下「写入屏障」：此刻之后产生的日志才算这次写入引发的。

    每次 write_file 都调一下；多次写入时，最后一次的屏障生效。
    """
    _barrier[session_id] = _next_seq[session_id]


def logs_since_write(session_id: str) -> list[BrowserLog]:
    """取出「屏障之后」的日志（即最近一次 write_file 之后产生的）。"""
    barrier = _barrier[session_id]
    return [e.log for e in _store[session_id] if e.seq >= barrier]

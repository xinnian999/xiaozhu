"""付费/额度配置 —— 套餐档位的单一真相源。

本项目的计费模型（极简版）：
  - 三档套餐：free / pro / max，每档每天有固定「点数」额度，隔天重置、不累积、不结转。
  - 一轮对话扣「模型倍率」点（见 llm.py 里每个模型的 cost：普通 1、贵的 2）。
  - 扣费只扣「当日额度」，扣完当天就拦（402），第二天自然恢复。没有永久余额、没有充值加点——
    所谓「升级/付费」就是把用户换到更高档（更大的每日桶）。

扣费时机是「成功才扣」（post-charge）：开跑前只校验额度够不够（不够 402、但不扣），
一轮干净跑完（正常走到 done，没报错 / 没截断 / 没被用户中断）才真正 += cost。
没跑完一律不扣，所以也不存在「中断了要不要返还」的问题。
"""

from datetime import date


def used_today(user, today: date) -> int:
    """该用户「今天」已用的点数。

    user 是 User ORM 对象（这里不标类型、只鸭子调用 .daily_used / .daily_date，
    免得 billing 反过来 import models 造成循环依赖）。
    关键：daily_used 记的是 daily_date 那天的用量；若 daily_date 不是今天，说明跨天了、
    昨天的用量不算数 → 今天从 0 起。真正的「重置写库」在扣费时做（见 loop 的扣费处），
    这个函数只是「读」出今天的有效用量，给校验和展示用，不写库。
    """
    return user.daily_used if user.daily_date == today else 0

# 每档的「每日点数额度」。和 users.tier 的取值一一对应。
# 改额度只动这里一处；以后加新档（如 team）也只在这里加一行 + 允许 tier 取该值。
TIER_DAILY: dict[str, int] = {
    "free": 15,
    "pro": 50,
    "max": 100,
}

# 默认档位：新用户 / 未知档位都按 free 兜底，保证 TIER_DAILY 一定查得到值。
DEFAULT_TIER = "free"


def daily_allowance(tier: str) -> int:
    """按档位取每日额度。给到不认识的档位时退回 free，避免 KeyError 把请求打挂。"""
    return TIER_DAILY.get(tier, TIER_DAILY[DEFAULT_TIER])

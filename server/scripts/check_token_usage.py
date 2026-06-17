"""探针：验证「流式 + ReAct」下能不能拿到并累加每轮对话的 token 用量。

这是付费系统「计量地基」的前置探路（只探测、不建表、不碰数据库、不动业务代码）。
要回答两个问题：
  1. 在 loop.py 现在的 astream(stream_mode=["updates","messages"]) 跑法下，
     updates 模式的 model 节点消息，到底取不取得到 token 用量？
  2. 一轮对话 = 多次 LLM 调用（ReAct：想→调工具→再想），多步能不能正确累加出总 token？

做法：用两个「假工具」（不碰库）搭一个和 loop.py 同款的 create_agent，喂一个会触发
多次工具调用的 prompt，然后遍历事件流，把每个 model 节点的用量打出来并累加。

为排除「流式默认不带 usage」的坑，对每个模型测两种构造：
  A) 默认 build_llm（应用现在就这么用）
  B) 额外开 stream_usage=True（langchain_openai 流式回传用量的开关）
对照着看哪种取得到，从而决定计量地基该怎么取数。

运行（在 server 目录下）：
    uv run python scripts/check_token_usage.py
    uv run python scripts/check_token_usage.py qwen3.6-plus
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from langchain.agents import create_agent  # noqa: E402
from langchain_core.messages import HumanMessage  # noqa: E402
from langchain_core.tools import tool  # noqa: E402

from app.llm import AVAILABLE_MODELS, build_llm  # noqa: E402


# ── 两个假工具：只返回固定文本，不碰数据库 ──────────────────────────────────────
# 目的是诱导模型多调几次工具，从而产生多个 model 节点（多次 LLM 调用），好验证累加。
@tool
def read_note(name: str) -> str:
    """读取一个便签的内容。name 是便签名。"""
    return f"便签 {name} 的内容是：今天要买牛奶和鸡蛋。"


@tool
def word_count(text: str) -> str:
    """统计一段文本的字数。"""
    return f"共 {len(text)} 个字符。"


PROMPT = (
    "请先用 read_note 读「购物清单」这张便签，再用 word_count 统计它内容的字数，"
    "最后用一句话告诉我结果。必须依次调用这两个工具。"
)


def _usage_of(msg) -> tuple[int, int] | None:
    """从一条 model 消息里抠出 (input_tokens, output_tokens)。取不到返回 None。

    两个来源都看：
      - usage_metadata：langchain 标准化后的用量（{input_tokens, output_tokens, ...}）
      - response_metadata.token_usage：OpenAI 原始字段（prompt_tokens / completion_tokens）
    """
    um = getattr(msg, "usage_metadata", None)
    if um:
        return int(um.get("input_tokens", 0)), int(um.get("output_tokens", 0))
    tu = (getattr(msg, "response_metadata", {}) or {}).get("token_usage") or {}
    if tu:
        return int(tu.get("prompt_tokens", 0)), int(tu.get("completion_tokens", 0))
    return None


async def probe(model_id: str, stream_usage: bool) -> None:
    """跑一轮，逐个 model 节点打印用量并累加。stream_usage 控制是否开启用量回传。"""
    llm = build_llm(model_id)
    if stream_usage:
        # langchain_openai 的开关：开了之后流式响应的最后一帧会带 usage
        llm = llm.bind(stream_usage=True)
    agent = create_agent(llm, [read_note, word_count])

    steps = 0
    total_in = 0
    total_out = 0
    found_any = False
    async for chunk in agent.astream(
        {"messages": [HumanMessage(content=PROMPT)]},
        stream_mode=["updates", "messages"],
        config={"recursion_limit": 20},
    ):
        # astream 传了 list 形式的 stream_mode，事件是 (mode, payload)
        mode, payload = chunk
        if mode != "updates":
            continue
        for node_name, update in payload.items():
            if node_name != "model":
                continue
            for m in update.get("messages", []) if isinstance(update, dict) else []:
                steps += 1
                u = _usage_of(m)
                if u is None:
                    print(f"    第 {steps} 次 LLM 调用：✗ 取不到用量")
                else:
                    found_any = True
                    total_in += u[0]
                    total_out += u[1]
                    print(f"    第 {steps} 次 LLM 调用：in={u[0]} out={u[1]}")

    tag = "开 stream_usage" if stream_usage else "默认 build_llm"
    if found_any:
        print(f"  [{tag}] ✅ 取到用量；共 {steps} 次调用，累加 in={total_in} out={total_out}")
    else:
        print(f"  [{tag}] ❌ 全程取不到用量（{steps} 次调用都没有）")


async def main() -> None:
    import asyncio  # noqa: F401  （已在 asyncio.run 外层；此处仅占位说明）

    wanted = sys.argv[1:]
    all_ids = [m["id"] for m in AVAILABLE_MODELS]
    targets = [m for m in (wanted or all_ids) if m in all_ids]

    for model_id in targets:
        print(f"\n=== {model_id} ===")
        for su in (False, True):
            try:
                await probe(model_id, stream_usage=su)
            except Exception as e:
                tag = "开 stream_usage" if su else "默认 build_llm"
                print(f"  [{tag}] 报错：{type(e).__name__}: {str(e)[:120]}")
    print()


if __name__ == "__main__":
    import asyncio

    asyncio.run(main())

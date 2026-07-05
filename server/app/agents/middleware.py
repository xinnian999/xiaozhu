"""Agent 中间件：给【严禁嘴炮】规则加一道代码层兜底。

prompts.py 的 SYSTEM_PROMPT 里已经用文字明令禁止"没调用工具就声称完成了修改"，
但纯提示词约束不了 100% 场景 —— 真实跑下来发现过模型说一句"标题已更新为……"
就把这轮结束了，实际一个工具都没调用，文件毫无变化，用户却看到一份像模像样
的"完成报告"。

这里在图层面加一道硬性检查：模型一旦给出"这轮完全没调用任何工具、但文本里却
在宣称某项修改已完成"的回复，就不把它当成这一轮的最终答案放行，而是打回
model 节点重新来一遍，逼它要么真的动手，要么如实说明还没处理。
"""

import re
from typing import Any

from langchain.agents.middleware import AgentMiddleware, AgentState, hook_config
from langchain.agents.middleware.types import PrivateStateAttr
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from typing_extensions import Annotated, NotRequired

# 和 SYSTEM_PROMPT 里【严禁嘴炮】列出的动词对应，命中任一个就算"宣称完成"。
# 只在"这轮零工具调用"时才会拿来判定，所以宁可覆盖广一点，也不怕误伤——
# 真调用过工具的回复根本不会走到这条正则。
_CLAIM_RE = re.compile(
    r"已(?:经)?(?:新增|实现|优化|修改|完成|更新|调整|升级|写入|写好|改好|加上|接入|启用|上线)"
)

_CORRECTION = (
    "系统提示（非用户发言）：你上一条回复没有调用任何工具（write_file / edit_file / "
    "check_build / ask_user 等），但文字里却在宣称某项修改“已完成/已实现/已更新”。"
    "这是不允许的（严禁嘴炮）。请二选一：\n"
    "1. 如果这一轮确实需要改代码，现在【立即实际调用工具】把刚才说的那些改动真正做出来，"
    "做完再如实总结；\n"
    "2. 如果这一轮本来就不需要改代码（纯提问 / 讨论），把回复改写成如实反映现状的说法，"
    "不要再用“已经…了”这类暗示刚做完修改的措辞。"
)


class NoBluffState(AgentState):
    """给 NoBluffMiddleware 用的私有计数字段：本轮已经纠正过几次。

    PrivateStateAttr 让这个字段只在图内部流转，不会混进最终吐给调用方的输出。
    不用担心跨轮累积——本项目每轮用独立 thread_id（见 app.agents.loop），
    每轮都是全新 state，天然从 0 开始。
    """

    bs_correction_count: NotRequired[Annotated[int, PrivateStateAttr]]


class NoBluffMiddleware(AgentMiddleware):
    """拦截"零工具调用 + 文本却宣称已完成修改"的回复，强制打回重来。"""

    state_schema = NoBluffState

    # 一轮最多纠正这么多次；模型纠正后仍嘴硬的话，别无限重试烧 token，放它过去。
    MAX_CORRECTIONS = 2

    @hook_config(can_jump_to=["model"])
    def after_model(self, state: NoBluffState, runtime: Any) -> dict[str, Any] | None:
        messages = state["messages"]
        last = messages[-1]
        if not isinstance(last, AIMessage) or last.tool_calls:
            return None  # 这轮调了工具（或压根没轮到它判断），不归这条规则管

        # 从消息尾部往回找到本轮起点（最近一条 HumanMessage）；期间只要出现过
        # ToolMessage，就说明这轮其实真的调用过工具（只是最后一条恰好没调），不是嘴炮。
        for m in reversed(messages[:-1]):
            if isinstance(m, HumanMessage):
                break
            if isinstance(m, ToolMessage):
                return None

        if not _CLAIM_RE.search(last.text):
            return None

        count = state.get("bs_correction_count", 0)
        if count >= self.MAX_CORRECTIONS:
            return None

        return {
            "jump_to": "model",
            "messages": [HumanMessage(content=_CORRECTION)],
            "bs_correction_count": count + 1,
        }

    async def aafter_model(self, state: NoBluffState, runtime: Any) -> dict[str, Any] | None:
        return self.after_model(state, runtime)

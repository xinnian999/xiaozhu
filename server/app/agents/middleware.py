"""Agent 中间件：给【严禁嘴炮】规则加一道代码层兜底。

prompts.py 的 SYSTEM_PROMPT 里已经用文字明令禁止"没调用工具就声称完成了修改"，
但纯提示词约束不了 100% 场景 —— 真实跑下来发现过模型说一句"标题已更新为……"
就把这轮结束了，实际一个工具都没调用，文件毫无变化，用户却看到一份像模像样
的"完成报告"。

这里在图层面加一道硬性检查：模型一旦给出"这轮完全没调用任何工具、但文本里却
在宣称某项修改已完成"的回复，就不把它当成这一轮的最终答案放行，而是打回
model 节点重新来一遍，逼它要么真的动手，要么如实说明还没处理。

【检测方式的演进】最早这里是一条关键词正则——命中"已经新增/实现/优化/……"这类
动词才算嘴炮。实测漏过真实案例（session 4aae05ff..., message 249）：AI 说
"已为 Elin 博客增加了深色/浅色主题切换功能"，这一轮零工具调用、纯编造，却因为
动词表没收"增加"（只有"新增"）、且句式在"已"和动词之间插了"为 Elin 博客"这段
宾语，正则完全没命中，直接放行。事后把动词表和句式都打了补丁，但这只是把天花板
往上挪了一格——关键词黑名单永远猜不完模型可能换的说法/语言/句式，治标不治本。

现在换个思路：既然"这一轮零工具调用"本身是从消息历史里能确凿判断的硬事实（不是
猜的——真调用过工具一定会留下 ToolMessage），就只在这个前提成立时，另外发起一次
【轻量模型调用】，把 AI 那段回复原文原样甩给同一个模型（不绑工具的裸调用），直接
问它"这段话是不是在暗示某个具体的代码改动已经完成"——不再关心具体用了哪个动词、
中文还是英文、多绕的句式，语义理解本来就是模型的强项，比穷举正则可靠得多。
这次额外调用只发生在"零工具调用"的少数情况下（真调用过工具的回复根本走不到这里），
且是服务端内部调用，不会重复计费——本项目按"整轮成功结束时按模型倍率扣一次"计费
（见 app.agents.loop 的"扣费"注释），和这一轮内部实际发起过几次模型调用无关。
"""

from typing import Any

from langchain.agents.middleware import AgentMiddleware, AgentState, hook_config
from langchain.agents.middleware.types import PrivateStateAttr
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from typing_extensions import Annotated, NotRequired

# 语义判断用的 system prompt：只问一件事——这段话是不是在宣称已完成某项代码改动。
# "零工具调用"这个前提已经由调用方确认过，这里不用再重复判断。
_JUDGE_SYSTEM = (
    "你是一个「内容真实性判定器」。下面是一段 AI 编程助手对用户说的回复，重要前提："
    "这一轮对话里这个助手【一次工具调用都没有发起】——没有 write_file / edit_file / "
    "check_build 等任何真实操作，项目代码没有发生任何变化。\n\n"
    "请只判断一件事：这段回复的文字内容，是不是在向用户暗示或宣称"
    "「某项具体的代码修改 / 功能 / 配置已经完成、已经生效」？"
    "（比如说加了什么功能、改了什么样式、修了什么 bug、写了什么文件——只要是在暗示"
    "「事情已经做完了」，不管用没用「已经」这个词、什么语言、什么句式，都算命中。）\n\n"
    "如果这段话只是提问、讨论、解释概念，或者如实说明「还没开始处理 / 需要先确认」，"
    "都不算命中。\n\n"
    "只回答一个字：是 或 否。不要输出任何其他文字、标点或解释。"
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


def _extract_text(content: Any) -> str:
    """从模型回复的 content 里取纯文本。多数情况下 content 就是字符串；个别 provider
    /多模态场景会返回 list[block]，这里兜底拼接（和 loop.py 的 extract_text 同思路，
    这里不直接复用是为了避免 middleware ← loop 的反向 import）。
    """
    if isinstance(content, str):
        return content
    return "".join(
        block.get("text", "") if isinstance(block, dict) else getattr(block, "text", "")
        for block in content
    )


class NoBluffState(AgentState):
    """给 NoBluffMiddleware 用的私有计数字段：本轮已经纠正过几次。

    PrivateStateAttr 让这个字段只在图内部流转，不会混进最终吐给调用方的输出。
    不用担心跨轮累积——本项目每轮用独立 thread_id（见 app.agents.loop），
    每轮都是全新 state，天然从 0 开始。
    """

    bs_correction_count: NotRequired[Annotated[int, PrivateStateAttr]]


class NoBluffMiddleware(AgentMiddleware):
    """拦截"零工具调用 + 却在宣称已完成修改"的回复，强制打回重来。

    判定方式见模块顶部说明：不用关键词正则黑名单，靠一次轻量模型调用做语义判断。
    """

    state_schema = NoBluffState

    # 一轮最多纠正这么多次；模型纠正后仍嘴硬的话，别无限重试烧 token，放它过去。
    MAX_CORRECTIONS = 2

    def __init__(self, llm: BaseChatModel):
        """llm：这一轮本来就构造好的模型实例（未绑工具的裸对象，见 app.agents.loop /
        app.api.ask_result 里 build_llm(model) 的返回值）。语义判断复用它做一次额外
        调用——不引入"专门配一个更便宜的裁判模型"这个新概念，省掉一处要单独维护
        api_key / 是否启用的配置点；反正只在零工具调用的少数情况下才触发。
        """
        super().__init__()
        self._llm = llm

    async def _looks_like_bluff(self, text: str) -> bool:
        """语义判断：这段回复是不是在"零工具调用"的情况下宣称"已完成某项修改"。

        调用失败（网络抖动 / 限流等）时兜底放行——这道检查是"锦上添花"的安全网，
        不该因为它自己出错就把用户这一轮本来正常的回复也拖垮。
        """
        if not text.strip():
            return False
        try:
            resp = await self._llm.ainvoke(
                [SystemMessage(content=_JUDGE_SYSTEM), HumanMessage(content=text)]
            )
        except Exception as e:
            print(f"[NoBluff] 语义判断调用失败，本次放行: {type(e).__name__}: {e}")
            return False
        return _extract_text(resp.content).strip().startswith("是")

    @hook_config(can_jump_to=["model"])
    async def aafter_model(self, state: NoBluffState, runtime: Any) -> dict[str, Any] | None:
        # 本项目全程走 agent.astream()（见 app.agents.loop / app.api.ask_result），
        # LangGraph 在 before/after_model 只覆盖了异步版本时也能正常工作——这个类
        # 干脆不覆盖同步的 after_model，因为语义判断天然要发一次网络请求，没必要
        # 硬凑一个同步版本（真凑了也没人会走到那条路径）。
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

        count = state.get("bs_correction_count", 0)
        if count >= self.MAX_CORRECTIONS:
            return None

        if not await self._looks_like_bluff(last.text):
            return None

        return {
            "jump_to": "model",
            "messages": [HumanMessage(content=_CORRECTION)],
            "bs_correction_count": count + 1,
        }

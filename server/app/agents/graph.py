"""用 LangGraph 重写 agent 循环 —— 学习用,逐步替代 loop.py 的手写循环。

阶段一目标:在这里从零搭一个最小可跑的两节点图(调 LLM ⇄ 执行工具),
先 invoke 跑通,不接 SSE、不接数据库。吃透之后再迁移进 loop.py。
"""

from typing import Annotated, TypedDict

from langchain_core.messages import AnyMessage, ToolMessage
from langgraph.graph import END, START, StateGraph, add_messages


# ── State:图在各节点间传递的「状态」──────────────────────────────────────────────
# 对应你 loop.py 里那个在 while 循环里传来传去的 messages 列表。
# LangGraph 要求把状态显式声明成一个 TypedDict(类似 TS 的 interface)。

class AgentState(TypedDict):
    # messages 是核心状态:整段对话历史(System / Human / AI / Tool 消息)。
    #
    # 重点是 Annotated[..., add_messages] 里的第二个参数 add_messages —— 它是一个
    # 「reducer(归并函数)」。节点返回 {"messages": [...]} 时,LangGraph 不会用新值
    # 直接覆盖旧 list,而是调用 add_messages(旧list, 新list) 把新消息「追加」进去。
    #
    # 换句话说:loop.py 里你手写的 `messages.append(response)`,在图里被这个 reducer
    # 自动接管了 —— 节点只管「我这一步新产生了哪些消息」,怎么并回总历史交给 add_messages。
    messages: Annotated[list[AnyMessage], add_messages]


# ── Node:图里干活的单元 ──────────────────────────────────────────────────────────
# 节点就是一个普通函数:吃当前 state,吐出「对 state 的更新」。
# 这里先写「调 LLM」这个节点 —— 对应 loop.py 里 `response = llm.invoke(messages)` 那段。

def make_call_model(llm):
    """构造 call_model 节点。

    用闭包把 llm「封」进去 —— 和你 loop.py 里 build_tools 用闭包封 db 是同一个套路。
    节点函数本身的签名必须是「吃 state、吐 update」,没法再多塞 llm 参数,
    所以靠闭包从外面注入。
    """

    def call_model(state: AgentState) -> dict:
        # 节点的活儿:把当前对话历史喂给 LLM,拿回它这一步的回复。
        # state["messages"] 就是 add_messages 累积到现在的完整历史。
        response = llm.invoke(state["messages"])
        # 关键:节点只 return「这一步新增了什么」,不返回整个 state。
        # {"messages": [response]} 会经过上面给 messages 挂的 add_messages reducer,
        # 自动追加进总历史 —— 所以这里**不需要**手动 messages.append(response)。
        # 对比 loop.py:那边你得自己 `messages.append(response)`,这里交给了 reducer。
        return {"messages": [response]}

    return call_model


# ── Node:tools(执行工具)────────────────────────────────────────────────────────
# 对应 loop.py 里那段 `for tool_call in response.tool_calls: ... ainvoke(args)`。
# 它的活儿:把上一步 LLM 要求调用的工具一个个执行,结果包成 ToolMessage 返回。

def make_tool_node(tools):
    """构造 tools 节点。同样用闭包注入工具列表。"""
    tools_by_name = {t.name: t for t in tools}

    def tool_node(state: AgentState) -> dict:
        # 进到这个节点,说明历史里最后一条一定是「带 tool_calls 的 AIMessage」
        #(否则条件边不会把流程引到这儿来,见下面 should_continue)。
        last_message = state["messages"][-1]

        results = []
        for tool_call in last_message.tool_calls:
            tool = tools_by_name[tool_call["name"]]
            output = tool.invoke(tool_call["args"])
            # 每个工具结果都要包成 ToolMessage,并带上 tool_call_id —— LLM 靠这个 id
            # 把「结果」和「它刚才发起的那次调用」对上号。这步和 loop.py 里
            # `ToolMessage(content=..., tool_call_id=tool_call["id"])` 一模一样。
            results.append(
                ToolMessage(content=str(output), tool_call_id=tool_call["id"])
            )
        # 一次可能调多个工具,就返回多条 ToolMessage,reducer 会一起追加进历史。
        return {"messages": results}

    return tool_node


# ── 条件边:看 LLM 还想不想调工具,决定下一步去哪 ───────────────────────────────────
# 这就是你 loop.py 里 `if not response.tool_calls: break` 那个判断,
# 只不过现在它的「返回值」是一个节点名,告诉图「接下来跳去哪个节点」。

def should_continue(state: AgentState) -> str:
    last_message = state["messages"][-1]
    # 最后一条 AI 回复里带了 tool_calls → 还要干活,去 tools 节点
    if last_message.tool_calls:
        return "tools"
    # 没有 tool_calls → LLM 说完了,结束
    return END


# ── Graph:把两个节点连成「会拐弯」的图 ─────────────────────────────────────────────
# 形状从上一步的直线,变成带回路的 ReAct 循环:
#
#           ┌─────────────────────────────┐
#           ↓                             │ (tools 跑完,绕回)
#   START → call_model ──should_continue──┤
#                                         │ (还要调工具)→ tools ──┘
#                                         │ (不调了)→ END

def build_graph(llm, tools):
    """组装并编译一个 ReAct 图。tools 从外部传入(和 loop.py 一样按请求构造)。"""
    # 关键:llm 必须先 bind_tools,它才会在回复里产出 tool_calls。
    # 不绑工具的话,LLM 根本不知道有哪些工具可调,should_continue 永远走 END。
    llm = llm.bind_tools(tools)

    graph = StateGraph(AgentState)
    graph.add_node("call_model", make_call_model(llm))
    graph.add_node("tools", make_tool_node(tools))

    # 入口照旧:START → call_model
    graph.add_edge(START, "call_model")

    # 条件边:call_model 之后,用 should_continue 的返回值决定去哪。
    # 第三个参数是「返回值 → 目标节点」的映射表,写出来流向更直观。
    graph.add_conditional_edges(
        "call_model",
        should_continue,
        {"tools": "tools", END: END},
    )

    # 绕回边:tools 跑完,无条件回到 call_model —— 这条边就是「循环」的本体,
    # 等价于你 while 循环里「执行完工具后回到顶部再调一次 LLM」。
    graph.add_edge("tools", "call_model")

    return graph.compile()

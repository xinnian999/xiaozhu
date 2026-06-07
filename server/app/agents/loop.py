"""Agentic Loop —— agent 的核心循环。

「LLM 决策 → 执行工具 → 回传结果 → LLM 继续」的循环本体，以及它的输入契约
（ChatRequest）和两个 SSE 辅助函数都放这里。路由层（app.api.chat）只负责
鉴权 / 校验，然后把请求交给本模块的 agent_loop 去跑。

不做 token 流，先跑通这个循环。流式体验后续再加，核心逻辑不变。
"""

import json
from collections.abc import AsyncGenerator

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agents.prompts import SYSTEM_PROMPT
from app.agents.tools import build_tools
from app.llm import build_llm
from app.models.file import File
# 起别名 DBMessage 避免和 langchain_core.messages 概念混淆
# （那边的 SystemMessage/HumanMessage 是 LLM 对话消息，这里的是数据库行）
from app.models.message import Message as DBMessage
from app.versioning import snapshot_current_files


# ── 请求体 ──────────────────────────────────────────────────────────────────────

class ChatRequest(BaseModel):
    # session_id 改为必填：会话必须先通过 POST /api/sessions 创建。
    # Pydantic 缺字段时 FastAPI 自动返 422，不用我们手动校验。
    session_id: str
    message: str
    # 前端选的模型。可选 —— 不传就用白名单第一个（默认模型），
    # 这样老前端 / curl 不带 model 也能照常工作，向后兼容。
    # 注意：这里只接收字符串，「是否在白名单内」的校验放在路由层做（见 chat 函数），
    # 因为校验不通过要返回 HTTP 400，而 Pydantic 字段校验器不方便返回自定义 HTTP 状态码。
    model: str | None = None


# ── SSE 工具函数 ────────────────────────────────────────────────────────────────

def sse(event: dict) -> str:
    return f"data: {json.dumps(event, ensure_ascii=False)}\n\n"


def extract_text(response: AIMessage) -> str:
    """从 AIMessage 里取出纯文本内容。

    绑定工具后，content 可能是普通字符串，也可能是
    list[{"type": "text", "text": "..."}] 这样的 block 列表
    （模型边说话边调工具时常见），后者要把所有 text block 拼起来。
    """
    content = response.content
    if isinstance(content, str):
        return content
    return "".join(
        block.get("text", "") if isinstance(block, dict) else getattr(block, "text", "")
        for block in content
    )


# ── Agentic Loop ────────────────────────────────────────────────────────────────

async def agent_loop(req: ChatRequest, db: AsyncSession) -> AsyncGenerator[str, None]:
    """工具调用循环：LLM 决策 → 执行工具 → 回传结果 → LLM 继续，直到没有工具调用。"""
    # 每请求构造一次工具 + bind_tools，因为工具闭包了请求级别的 db / session_id
    tools = build_tools(db, req.session_id)
    tools_by_name = {t.name: t for t in tools}
    # 按本次请求选的模型现造 LLM 再 bind_tools。req.model 已在路由层校验过白名单，
    # 这里直接用。这是「每条消息可变模型」的落点：同一会话里这条用 qwen、
    # 下条用 claude 都行，因为每次进 agent_loop 都重新构造。
    llm = build_llm(req.model).bind_tools(tools)

    # 入库小助手：把一条消息写进 messages 表。闭包捕获 db / session_id，
    # 调用处只关心"存什么"。每存一条就 commit，保证自增 id 单调递增 ——
    # 回显时按 id 升序排，顺序就和当时直播看到的一模一样。
    async def save_message(
        role: str,
        text: str,
        *,
        kind: str = "text",
        tool_name: str | None = None,
        tool_args: dict | None = None,
    ) -> None:
        db.add(DBMessage(
            session_id=req.session_id,
            role=role,
            text=text,
            kind=kind,
            tool_name=tool_name,
            tool_args=tool_args,
        ))
        await db.commit()

    # 1. 先把用户消息入库 —— 即便 LLM 调用失败，用户消息也已经持久化，
    #    刷新后能看到自己发了什么
    await save_message("user", req.message)

    # 2. 加载历史对话作为上下文，让 LLM 记得之前聊过什么。
    #    只取 kind='text'（user 输入 + assistant 说过的话），把 kind='tool' 的
    #    工具行过滤掉 —— 工具的效果已经体现在 files 表的现状里，把工具调用重放给
    #    LLM 反而会让它误以为还要再调一次。kind 字段在这里第二次发挥作用。
    result = await db.execute(
        select(DBMessage)
        .where(DBMessage.session_id == req.session_id, DBMessage.kind == "text")
        .order_by(DBMessage.created_at.asc(), DBMessage.id.asc())
    )
    history = result.scalars().all()

    messages = [SystemMessage(content=SYSTEM_PROMPT)]
    for m in history:
        if m.role == "user":
            messages.append(HumanMessage(content=m.text))
        else:
            messages.append(AIMessage(content=m.text))

    # 累积本轮 assistant 的最终文本，用于结束时入库
    final_assistant_text = ""
    # 本轮是否真的写过文件 —— 只有写过才在结束时打一个版本快照，
    # 纯聊天 / 报错空转的轮次不该产生空版本。
    wrote_files = False

    # 硬性轮次上限：prompt 让 agent「最多修 3 轮」是软约束，模型未必听话。
    # 加一个兜底计数，防止「写错→检查→修错→再检查→……」无限烧 token。
    # 一次正常生成 + 几轮自检修复，25 轮足够；超了就强制收尾。
    MAX_TURNS = 25
    turns = 0

    try:
        while True:
            turns += 1
            if turns > MAX_TURNS:
                yield sse({
                    "type": "error",
                    "message": f"已达最大轮次（{MAX_TURNS}），自动停止以防死循环。",
                })
                break

            # astream：流式收取这一轮回复。它吐出一连串 AIMessageChunk（消息碎片），
            # 我们一边把新增文本实时推给前端（打字效果），一边用 `+` 把碎片累加回一个
            # 完整的 AIMessage —— AIMessageChunk 的 `+` 会自动拼接文本、聚合 tool_calls
            # 的碎片参数。累加完的 response 和原来 ainvoke 的结果等价，所以下面执行工具
            # 的逻辑一行都不用改。
            response: AIMessage | None = None
            async for chunk in llm.astream(messages):
                # 第一个碎片直接当起点，之后逐个累加
                response = chunk if response is None else response + chunk
                # 把「这个碎片」新增的文本增量实时推给前端。注意只推 chunk 自己的
                # 增量，不是累加后的全文，否则前端会收到越来越长的重复文本。
                delta = extract_text(chunk)
                if delta:
                    yield sse({"type": "message_delta", "text": delta})
            messages.append(response)  # 把拼好的完整回复追加进历史

            # content 和 tool_calls 是两个独立字段：模型可能只说话、只调工具，
            # 也可能「边说边调」。所以每一轮都先把文本取出来。
            text = extract_text(response)

            # finish_reason：模型为什么停。"stop"=正常说完，"tool_calls"=要调工具，
            # "length"=撞 max_tokens 被截断。截断时 write_file 的参数 JSON 是残缺的，
            # langchain 解析不出合法 tool_calls，会丢进 invalid_tool_calls。
            finish_reason = response.response_metadata.get("finish_reason")
            if response.invalid_tool_calls or finish_reason == "length":
                print(
                    f"[截断] finish_reason={finish_reason} "
                    f"invalid_tool_calls={response.invalid_tool_calls}"
                )
                yield sse({
                    "type": "error",
                    "message": "模型输出超长被截断，文件没写完。请把需求拆小，或分多次生成。",
                })
                break

            if not response.tool_calls:
                # 最终回复：文本已在上面的流式循环里逐字推过了，这里不再重复推，
                # 只记下来用于结束时入库（空字符串就不存）。
                if text:
                    final_assistant_text = text
                print(f"[最终回复] content={text}")
                break

            # 这一轮要调工具，但模型可能同时说了话（开场白 / 进度解释，
            # 如「好的，我先看看项目结构」）。这类过场叙述也是对话流的一部分：
            # 实时展示已经由流式循环完成，这里只负责入库（kind='text'），
            # 让刷新后能完整还原。
            if text:
                print(f"[response] content={text} (同轮调用了工具)")
                await save_message("assistant", text)

            # LLM 要调用一个或多个工具
            for tool_call in response.tool_calls:
                name = tool_call["name"]
                args = tool_call["args"]

                print(f"[tool_call] name={name} args={list(args.keys())}")

                # 推进度提示，让前端能显示"正在写入 App.tsx…"
                yield sse({"type": "tool_call", "name": name, "args": args})
                # 工具调用本身也存成一行消息（kind='tool'），回显时还原成工具卡
                await save_message("assistant", "", kind="tool", tool_name=name, tool_args=args)

                if name not in tools_by_name:
                    # 调了不存在的工具，告诉 LLM 并继续
                    messages.append(
                        ToolMessage(content=f"工具 {name} 不存在", tool_call_id=tool_call["id"])
                    )
                    continue

                tool_result = await tools_by_name[name].ainvoke(args)
                messages.append(
                    ToolMessage(content=str(tool_result), tool_call_id=tool_call["id"])
                )

                # get_browser_logs 的结果（报错详情 / "运行正常"）打到后端日志，方便排查。
                # 前端不展示，所以不推事件、也不入库。
                if name == "get_browser_logs":
                    print(f"[browser_logs] {tool_result}")

                # write_file 落库成功后，把整文件推给前端。注意：前端只用它更新
                # 代码视图 / 文件树，**不会**立刻同步进运行中的预览 —— 预览要等 AI 主动
                # 调 update_preview 才揭晓，避免把「组件写好、样式没跟上」的半成品闪给用户。
                if name == "write_file":
                    wrote_files = True
                    yield sse({
                        "type": "file_write",
                        "path": args["path"],
                        "content": args["content"],
                    })
                # edit_file 只改了局部，args 里没有完整内容（那正是省 token 的关键）。
                # 但前端要整文件 mount 进 WebContainer，所以这里把改完后的完整内容从库里
                # 读回来，再用同一个 file_write 事件推下去 —— 对前端来说和 write_file 没区别。
                # 只在「真的改成功」时才推：edit_file 成功返回 "已编辑 {path}"，失败（文件不
                # 存在 / 没匹配上 / 匹配多处）返回别的说明文字。用这个判定，避免给一次没改动的
                # 失败也推 file_write、还误打一个空版本快照。
                elif name == "edit_file" and tool_result == f"已编辑 {args['path']}":
                    res = await db.execute(
                        select(File.content).where(
                            File.session_id == req.session_id, File.path == args["path"]
                        )
                    )
                    content = res.scalar_one_or_none()
                    if content is not None:
                        wrote_files = True
                        yield sse({
                            "type": "file_write",
                            "path": args["path"],
                            "content": content,
                        })
                # AI 觉得「这一组改动写完、可以渲染了」时调 update_preview，
                # 这里推一个 preview_refresh 信号，前端收到才把暂存的文件同步进预览。
                elif name == "update_preview":
                    yield sse({"type": "preview_refresh"})

        # LLM 给出最终回复后，把 assistant 文本入库（空字符串就不存）
        if final_assistant_text:
            await save_message("assistant", final_assistant_text)

        # 本轮若改动过文件，把当前 files 全量快照成一个新版本（单线递增）。
        # summary 用这轮用户的需求当说明，列表 UI 里好认。
        if wrote_files:
            version = await snapshot_current_files(
                db, req.session_id, summary=req.message[:100]
            )
            # 推送版本事件，让前端在对话流里实时插入一张「版本卡」（带回滚按钮）。
            # 版本卡消息本身已由 snapshot_current_files 落库，刷新后也能回显。
            if version is not None:
                yield sse({"type": "version", "version_id": version.id, "seq": version.seq})

        yield sse({"type": "done"})

    except Exception as e:
        yield sse({"type": "error", "message": str(e)})
        yield sse({"type": "done"})

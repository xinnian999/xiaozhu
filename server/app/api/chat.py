"""Chat API —— agentic loop 版本。

不做 token 流，先跑通「LLM → 工具调用 → 执行 → 回传结果 → LLM 继续」这个循环。
流式体验后续再加，核心逻辑不变。
"""

import json
from collections.abc import AsyncGenerator

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.tools import tool
from langchain_openai import ChatOpenAI
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.db import get_db
from app.models.file import File
# 起别名 DBMessage 避免和 langchain_core.messages 概念混淆
# （那边的 SystemMessage/HumanMessage 是 LLM 对话消息，这里的是数据库行）
from app.models.message import Message as DBMessage
from app.models.session import Session

router = APIRouter(prefix="/api", tags=["chat"])


# ── 基础 LLM ────────────────────────────────────────────────────────────────────
# 故意不在这里 bind_tools：工具实现要闭包捕获请求级别的 db / session_id，
# 所以每次请求才能把工具构造出来再 bind。
# 走 OpenAI 兼容协议：换中转更方便，且 Anthropic 协议的中转常会注入自己的工具集污染请求。
base_llm = ChatOpenAI(
    model=settings.llm_model,
    api_key=settings.openai_api_key,
    base_url=settings.openai_base_url,
    max_tokens=4096,
)


SYSTEM_PROMPT = """你是 Vibuild，一个 AI 前端代码生成助手。
用户描述他们想要的应用，你负责生成 React 业务代码。

【项目骨架已就绪】
当前项目是一个已经配置好的 Vite + React + TypeScript 项目，以下文件已经存在，禁止修改：
- package.json / vite.config.ts / tsconfig.json / index.html / .npmrc

你只需要修改 src/ 下的业务代码：
- src/main.tsx 是入口（已存在，一般不需要改）
- src/App.tsx 是根组件（已存在，按用户需求改写）
- src/index.css 是全局样式（已存在，可改）
- 需要更多组件时，在 src/components/ 下新建

【工作流程】
1. 先调 list_files 看当前项目结构
2. 修改已有文件前，必须先用 read_file 读取原内容
3. 用 write_file 写入文件（path 是相对路径，content 是完整内容，不能省略）
4. 完成后用一句话告诉用户做了什么

【禁止】
- 不要新增依赖（不要修改 package.json）
- 不要写 README、不要写测试文件
- 不要在 src 之外新建文件
"""


# ── 请求体 ──────────────────────────────────────────────────────────────────────

class ChatRequest(BaseModel):
    # session_id 改为必填：会话必须先通过 POST /api/sessions 创建。
    # Pydantic 缺字段时 FastAPI 自动返 422，不用我们手动校验。
    session_id: str
    message: str


# ── SSE 工具函数 ────────────────────────────────────────────────────────────────

def sse(event: dict) -> str:
    return f"data: {json.dumps(event, ensure_ascii=False)}\n\n"


# ── 工具工厂 ────────────────────────────────────────────────────────────────────
# 工具要操作"当前 session 的文件"，但 LLM 不该感知 session_id（那是后端会话身份，
# 不是业务参数）。所以这里用闭包把 db / session_id "封进去"，工具的 JSON Schema
# 里只暴露真正的业务参数（path / content）。每次请求重新构造一份工具实例，
# 因为它们绑定的是请求级别的 db。

def build_tools(db: AsyncSession, session_id: str) -> list:
    """构造一组绑定到指定 session 的工具。"""

    @tool
    async def write_file(path: str, content: str) -> str:
        """写入或覆盖一个文件。path 是相对路径（如 src/App.tsx），content 是完整文件内容。"""
        # upsert：File 表对 (session_id, path) 有唯一约束，
        # 已存在则改 content，不存在则新建。
        result = await db.execute(
            select(File).where(File.session_id == session_id, File.path == path)
        )
        existing = result.scalar_one_or_none()
        if existing is not None:
            existing.content = content
        else:
            db.add(File(session_id=session_id, path=path, content=content))
        await db.commit()
        return f"已写入 {path}"

    @tool
    async def read_file(path: str) -> str:
        """读取文件内容。修改已有文件前必须先调此工具，否则会覆盖原有代码。"""
        result = await db.execute(
            select(File).where(File.session_id == session_id, File.path == path)
        )
        f = result.scalar_one_or_none()
        if f is None:
            # 不抛异常 —— 返回字符串让 LLM 自己处理「文件不存在」的语义
            return f"文件 {path} 不存在"
        return f.content

    @tool
    async def list_files() -> str:
        """列出当前项目下所有文件路径。开始生成前先调用，了解项目现有结构。"""
        # 只 select 一列，比把整个 File 行拉出来再 .path 省内存
        result = await db.execute(select(File.path).where(File.session_id == session_id))
        return json.dumps(result.scalars().all(), ensure_ascii=False)

    return [write_file, read_file, list_files]


# ── Agentic Loop ────────────────────────────────────────────────────────────────

async def agent_loop(req: ChatRequest, db: AsyncSession) -> AsyncGenerator[str, None]:
    """工具调用循环：LLM 决策 → 执行工具 → 回传结果 → LLM 继续，直到没有工具调用。"""
    # 每请求构造一次工具 + bind_tools，因为工具闭包了请求级别的 db / session_id
    tools = build_tools(db, req.session_id)
    tools_by_name = {t.name: t for t in tools}
    llm = base_llm.bind_tools(tools)

    # 1. 先把用户消息入库 —— 即便 LLM 调用失败，用户消息也已经持久化，
    #    刷新后能看到自己发了什么
    db.add(DBMessage(session_id=req.session_id, role="user", text=req.message))
    await db.commit()

    # 2. 加载历史对话作为上下文，让 LLM 记得之前聊过什么。
    #    只保留 user / assistant 的最终内容，不重放中间的 tool_call —— 那些工具
    #    调用的结果已经体现在 files 表的现状里，重放反而会让 LLM 误以为还要再调一次。
    result = await db.execute(
        select(DBMessage)
        .where(DBMessage.session_id == req.session_id)
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

    try:
        while True:
            # ainvoke：等待 LLM 完整回复（非流式）
            response = await llm.ainvoke(messages)
            messages.append(response)  # 把回复追加进历史

            if not response.tool_calls:
                print(f"[response] content={response.content} (未调用工具)")
                # 绑工具后 content 可能是 list[{"type": "text", "text": "..."}]
                # 需要把所有 text block 拼起来
                if isinstance(response.content, str):
                    text = response.content
                else:
                    text = "".join(
                        block.get("text", "") if isinstance(block, dict) else getattr(block, "text", "")
                        for block in response.content
                    )
                if text:
                    yield sse({"type": "message_delta", "text": text})
                    final_assistant_text = text
                break

            # LLM 要调用一个或多个工具
            for tool_call in response.tool_calls:
                name = tool_call["name"]
                args = tool_call["args"]

                print(f"[tool_call] name={name} args={list(args.keys())}")

                # 推进度提示，让前端能显示"正在写入 App.tsx…"
                yield sse({"type": "tool_call", "name": name, "args": args})

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

                # write_file 落库成功后，立刻把整文件推给前端，
                # 前端会 mount 到 WebContainer 触发 Vite 热更新（渐进式预览的核心爽点）。
                if name == "write_file":
                    yield sse({
                        "type": "file_write",
                        "path": args["path"],
                        "content": args["content"],
                    })

        # LLM 给出最终回复后，把 assistant 文本入库（空字符串就不存）
        if final_assistant_text:
            db.add(DBMessage(
                session_id=req.session_id,
                role="assistant",
                text=final_assistant_text,
            ))
            await db.commit()

        yield sse({"type": "done"})

    except Exception as e:
        yield sse({"type": "error", "message": str(e)})
        yield sse({"type": "done"})


# ── 路由 ────────────────────────────────────────────────────────────────────────

@router.post("/chat")
async def chat(
    req: ChatRequest,
    db: AsyncSession = Depends(get_db),
) -> StreamingResponse:
    """SSE 流式对话。"""

    # 先校验 session 存在 —— 否则后面工具一调用就报外键错，体验差。
    # 这一步是普通查询，发生在 StreamingResponse 开始之前，
    # 报 404 用 HTTPException 是标准 FastAPI 写法。
    result = await db.execute(select(Session).where(Session.id == req.session_id))
    if result.scalar_one_or_none() is None:
        raise HTTPException(status_code=404, detail="Session not found")

    # 注意：StreamingResponse 拿到的是生成器，FastAPI 会保持 db 依赖存活
    # 直到生成器耗尽（即整个 SSE 流结束），所以工具里使用 db 是安全的。
    return StreamingResponse(
        agent_loop(req, db),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )

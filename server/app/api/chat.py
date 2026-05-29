"""Chat API —— agentic loop 版本。

不做 token 流，先跑通「Claude → 工具调用 → 执行 → 回传结果 → Claude 继续」这个循环。
流式体验后续再加，核心逻辑不变。
"""

import json
from collections.abc import AsyncGenerator

from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from langchain_anthropic import ChatAnthropic
from langchain_core.messages import HumanMessage, SystemMessage, ToolMessage
from langchain_core.tools import tool
from pydantic import BaseModel

from app.config import settings

router = APIRouter(prefix="/api", tags=["chat"])


# ── 工具定义 ────────────────────────────────────────────────────────────────────
# @tool 装饰器自动把类型注解 + docstring 转成 Claude 能读的 JSON Schema。
# 现在是 stub，后续接数据库时替换函数体即可，接口不变。

@tool
async def write_file(path: str, content: str) -> str:
    """写入或覆盖一个文件。path 是相对路径（如 src/App.tsx），content 是完整文件内容。"""
    # TODO: 接数据库 + 推 file_write SSE
    print(f"[write_file] {path}")
    return f"已写入 {path}"


@tool
async def read_file(path: str) -> str:
    """读取文件内容。修改已有文件前必须先调此工具，否则会覆盖原有代码。"""
    # TODO: 从数据库读
    print(f"[read_file] {path}")
    return f"// {path} 的内容（stub）"


@tool
async def list_files() -> str:
    """列出当前项目下所有文件路径。开始生成前先调用，了解项目现有结构。"""
    # TODO: 从数据库读
    return json.dumps(["src/App.tsx", "src/main.tsx", "package.json"])


# 工具名 → 工具对象的映射，执行时用来查找
TOOLS = {t.name: t for t in [write_file, read_file, list_files]}

# bind_tools 告诉 Claude 它有哪些工具可用
llm = ChatAnthropic(
    model=settings.claude_model,
    api_key=settings.anthropic_api_key,
    base_url=settings.anthropic_base_url,
    max_tokens=4096,
).bind_tools(list(TOOLS.values()))


SYSTEM_PROMPT = """你是 Vibuild，一个 AI 前端代码生成助手。
用户描述他们想要的应用，你负责生成完整可运行的 React + Vite 项目文件。

工作流程：
1. 调用 list_files 了解项目现有结构
2. 按需调用 read_file 读取要修改的文件
3. 调用 write_file 写入每个文件（package.json / vite.config / src/ 下的文件等）
4. 所有文件写完后，用一句话告诉用户项目已生成完毕
"""


# ── 请求体 ──────────────────────────────────────────────────────────────────────

class ChatRequest(BaseModel):
    message: str
    session_id: str | None = None


# ── SSE 工具函数 ────────────────────────────────────────────────────────────────

def sse(event: dict) -> str:
    return f"data: {json.dumps(event, ensure_ascii=False)}\n\n"


# ── Agentic Loop ────────────────────────────────────────────────────────────────

async def claude_agent(req: ChatRequest) -> AsyncGenerator[str, None]:
    """工具调用循环：Claude 决策 → 执行工具 → 回传结果 → Claude 继续，直到没有工具调用。"""
    messages = [
        SystemMessage(content=SYSTEM_PROMPT),
        HumanMessage(content=req.message),
    ]

    try:
        while True:
            # ainvoke：等待 Claude 完整回复（非流式）
            response = await llm.ainvoke(messages)
            messages.append(response)  # 把 Claude 的回复追加进历史

            if not response.tool_calls:
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
                break

            # Claude 要调用一个或多个工具
            for tool_call in response.tool_calls:
                name = tool_call["name"]
                args = tool_call["args"]

                print(f"[tool_call] name={name} args={list(args.keys())}")

                # 推进度提示
                yield sse({"type": "tool_call", "name": name, "args": args})

                if name not in TOOLS:
                    # Claude 调了不存在的工具，告诉它并继续
                    messages.append(
                        ToolMessage(content=f"工具 {name} 不存在", tool_call_id=tool_call["id"])
                    )
                    continue

                tool_result = await TOOLS[name].ainvoke(args)
                messages.append(
                    ToolMessage(content=str(tool_result), tool_call_id=tool_call["id"])
                )

        yield sse({"type": "done"})

    except Exception as e:
        yield sse({"type": "error", "message": str(e)})
        yield sse({"type": "done"})


# ── 路由 ────────────────────────────────────────────────────────────────────────

@router.post("/chat")
async def chat(req: ChatRequest) -> StreamingResponse:
    return StreamingResponse(
        claude_agent(req),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )

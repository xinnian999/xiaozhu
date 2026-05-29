"""Chat API —— 真实 Claude 接入的 SSE 流式端点。

核心知识点：
  1. langchain_anthropic.ChatAnthropic —— LangChain 封装的 Claude 客户端
  2. llm.astream(messages) —— async 流式迭代，每次 yield 一个文本 chunk
  3. FastAPI StreamingResponse —— 把 async generator 的输出直接作为 HTTP 响应体推送
  4. SSE 格式 —— 每帧是 `data: {...}\\n\\n`，前端用 EventSource 或 fetch+ReadableStream 读

对话历史（M1.5 简化版）：
  - 本阶段不存消息历史到数据库，每次请求都是全新对话。
  - 下一阶段加 LangGraph checkpoint 后，对话历史会自动持久化。
"""

import json
from collections.abc import AsyncGenerator

from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from langchain_anthropic import ChatAnthropic
from langchain_core.messages import HumanMessage, SystemMessage
from pydantic import BaseModel

from app.config import settings

router = APIRouter(prefix="/api", tags=["chat"])

# LangChain 的 ChatAnthropic 会自动读 ANTHROPIC_API_KEY 环境变量，
# 但我们显式传 api_key 让意图更清晰，也方便以后多 key 轮转。
llm = ChatAnthropic(
    model=settings.claude_model,
    api_key=settings.anthropic_api_key,
    # 中转服务地址，None 时 langchain-anthropic 自动用官方地址
    base_url=settings.anthropic_base_url,
    # max_tokens 限制单次生成长度，开发期控制成本。生产环境调大或去掉。
    max_tokens=4096,
)

# Vibuild 的系统 prompt —— 告诉 Claude 它的角色和输出格式
SYSTEM_PROMPT = """你是 Vibuild，一个 AI 代码生成助手。
用户会用自然语言描述他们想要的前端应用，你的任务是：
1. 先用简短的语言（1-2句）确认你理解了需求。
2. 说明你将要生成什么文件。

现在先聚焦在对话上，代码生成能力会在后续版本中集成。"""


# ── 请求体 ─────────────────────────────────────────────────────────────────────

class ChatRequest(BaseModel):
    message: str
    session_id: str | None = None  # 预留，M2 LangGraph 接入后会用到


# ── SSE 工具函数 ────────────────────────────────────────────────────────────────

def sse(event: dict) -> str:
    """把事件字典编码成 SSE 文本帧。"""
    return f"data: {json.dumps(event, ensure_ascii=False)}\n\n"


# ── 核心流式生成器 ──────────────────────────────────────────────────────────────

async def claude_stream(req: ChatRequest) -> AsyncGenerator[str, None]:
    """调用 Claude 并把响应映射到 SSE 事件流。

    llm.astream(messages) 返回一个异步迭代器，每次 yield 一个 AIMessageChunk。
    chunk.content 是这一帧的文本片段，我们把它包装成 message_delta 事件推送出去。
    """
    messages = [
        SystemMessage(content=SYSTEM_PROMPT),
        HumanMessage(content=req.message),
    ]

    try:
        async for chunk in llm.astream(messages):
            # AIMessageChunk.content 可能是 str 或 list（多模态时）
            # 目前只处理 str 情况
            if isinstance(chunk.content, str) and chunk.content:
                yield sse({"type": "message_delta", "text": chunk.content})

        # Claude 回复完毕 → 发 done 事件，前端关闭 stream
        yield sse({"type": "done"})

    except Exception as e:
        # 任何错误都包成 error 事件推给前端，而不是让连接静默断开
        yield sse({"type": "error", "message": str(e)})
        yield sse({"type": "done"})


# ── 路由 ────────────────────────────────────────────────────────────────────────

@router.post("/chat")
async def chat(req: ChatRequest) -> StreamingResponse:
    """SSE 流式对话端点，接入真实 Claude。

    StreamingResponse 接受一个 async generator，FastAPI 会逐帧推送给客户端，
    不需要等全部生成完才返回（这就是流式的意义）。
    """
    return StreamingResponse(
        claude_stream(req),
        media_type="text/event-stream",
        # 这两个 header 告诉浏览器/代理不要缓存、不要缓冲，实时推送
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )

"""Vibuild 后端入口 —— M1：FastAPI + 固定文件 SSE。

本阶段不接 Claude，所有事件都是写死的，目的是先把
「前端 → HTTP → SSE 流式事件 → 前端解析」这条管子打通，
并验证 TECH_DESIGN.md 第 6 节定的事件协议能正常工作。
"""

import asyncio
import json
from collections.abc import AsyncGenerator

from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

# FastAPI 应用实例，相当于整个后端服务的根对象
app = FastAPI(title="Vibuild Backend", version="0.1.0")

# CORS：前端（Vite 默认跑在 5173）与后端不同源，浏览器会拦跨域请求，
# 这里显式放行前端来源。生产环境再收紧，M1 先写死本地地址。
# app.add_middleware(
#     CORSMiddleware,
#     allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
#     allow_methods=["*"],
#     allow_headers=["*"],
# )


# ── 请求体模型 ────────────────────────────────────────────
# Pydantic 模型类似 TS 的 interface：声明字段和类型，
# FastAPI 会自动校验请求 JSON 并转成这个对象。
class ChatRequest(BaseModel):
    message: str
    session_id: str | None = None  # M1 还没有会话系统，先留着可选


# ── SSE 事件序列化 ────────────────────────────────────────
def sse(event: dict) -> str:
    """把一个事件字典编码成 SSE 文本帧。

    SSE 协议格式固定为 `data: <内容>\\n\\n`（两个换行表示一帧结束）。
    我们把事件对象转成 JSON 放进 data 字段，前端再 JSON.parse 还原。
    """
    return f"data: {json.dumps(event, ensure_ascii=False)}\n\n"


# M1 写死的「生成结果」：一个最简单的 React 组件文件
FIXED_FILE_PATH = "src/App.tsx"
FIXED_FILE_CONTENT = """\
export default function App() {
  return <h1>Hello from Vibuild 👋</h1>
}
"""


async def fake_chat_stream(req: ChatRequest) -> AsyncGenerator[str, None]:
    """模拟一次代码生成的事件流（异步生成器）。

    async generator：每 yield 一次就往 HTTP 响应里推一帧，
    中间用 asyncio.sleep 模拟「正在思考/生成」的耗时，
    这样前端能看到事件是陆续到达的，而不是一次性返回。
    """
    # 1) 助手对话，按 token 流（message_delta），模拟打字效果
    for chunk in ["好的，", "我来给你建", "一个最简单的", " React 页面。"]:
        yield sse({"type": "message_delta", "text": chunk})
        await asyncio.sleep(0.2)

    # 2) 进度提示：正在写文件（tool_call 仅用于前端显示进度）
    yield sse(
        {"type": "tool_call", "name": "write_file", "args": {"path": FIXED_FILE_PATH}}
    )
    await asyncio.sleep(0.3)

    # 3) 整文件写入事件（file_write 不是 token 流，是写完整后一次性推送）
    yield sse(
        {"type": "file_write", "path": FIXED_FILE_PATH, "content": FIXED_FILE_CONTENT}
    )
    await asyncio.sleep(0.2)

    # 4) 结束事件，前端收到后关闭 stream
    yield sse({"type": "done"})


# ── 路由 ──────────────────────────────────────────────────
@app.get("/health")
async def health() -> dict:
    """健康检查，确认服务活着。"""
    return {"status": "ok"}


@app.post("/chat")
async def chat(req: ChatRequest) -> StreamingResponse:
    """SSE 流式对话端点（M1 返回写死的事件流）。

    media_type 必须是 text/event-stream，浏览器才会按 SSE 处理。
    """
    return StreamingResponse(fake_chat_stream(req), media_type="text/event-stream")

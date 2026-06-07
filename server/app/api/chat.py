"""Chat API —— 路由层。

只负责 HTTP：鉴权、参数校验、把请求交给 agent 跑、用 SSE 流式回包。
真正的 agent 循环（LLM ↔ 工具）在 app.agents.loop，提示词在 app.agents.prompts，
工具在 app.agents.tools。这里不含任何业务逻辑。
"""

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agents.loop import ChatRequest, agent_loop
from app.db import get_db
from app.deps import get_current_user
# 模型注册表 + LLM 构造都集中在 app.llm，这里只是引用方
from app.llm import ALLOWED_MODEL_IDS, DEFAULT_MODEL_ID, public_models
from app.models.session import Session
from app.models.user import User

router = APIRouter(prefix="/api", tags=["chat"])


@router.get("/models")
async def list_models() -> list[dict]:
    """返回可选模型清单，给前端渲染下拉框。

    具体只吐哪些字段、为什么不含 group/api_key，见 app.llm.public_models。
    """
    return public_models()


@router.post("/chat")
async def chat(
    req: ChatRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> StreamingResponse:
    """SSE 流式对话。"""

    # 模型校验 + 填默认值。放在路由层（而不是 Pydantic 字段里），是因为校验不通过
    # 要返回 HTTP 400，HTTPException 在这里写最自然。
    #   - 没传 model：用白名单第一个当默认，保证老前端 / curl 不带 model 也能跑。
    #   - 传了但不在白名单：拒绝。绝不把未经许可的 model 字符串透传给中转。
    if req.model is None:
        req.model = DEFAULT_MODEL_ID
    elif req.model not in ALLOWED_MODEL_IDS:
        raise HTTPException(status_code=400, detail=f"不支持的模型：{req.model}")

    # 先校验 session 存在「且属于当前用户」—— 否则后面工具一调用就报外键错，体验差，
    # 更重要的是防止拿别人的 session_id 往别人项目里写代码。
    # session_id 在请求体里（不在路径上），所以这里手动按 id + user_id 过滤，
    # 查不到统一 404（不泄露会话是否存在）。
    result = await db.execute(
        select(Session).where(
            Session.id == req.session_id,
            Session.user_id == current_user.id,
        )
    )
    if result.scalar_one_or_none() is None:
        raise HTTPException(status_code=404, detail="Session not found")

    # 注意：StreamingResponse 拿到的是生成器，FastAPI 会保持 db 依赖存活
    # 直到生成器耗尽（即整个 SSE 流结束），所以工具里使用 db 是安全的。
    return StreamingResponse(
        agent_loop(req, db),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )

"""Chat API —— 路由层。

只负责 HTTP：鉴权、参数校验、把请求交给 agent 跑、用 SSE 流式回包。
真正的 agent 循环（LLM ↔ 工具）在 app.agents.loop，提示词在 app.agents.prompts，
工具在 app.agents.tools。这里不含任何业务逻辑。
"""

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agents.loop import ChatRequest, agent_loop, with_heartbeat
from app.billing import allowance_for, used_today
from app.db import get_db
from app.deps import get_current_user
# 模型注册表 + LLM 构造都集中在 app.llm，这里只是引用方。
# 现在模型在数据库、由内存缓存提供，所以引用的是「读缓存的函数」而非模块常量。
from app.llm import allowed_model_ids, default_model_id, models_by_id, public_models
from app.models.session import Session
from app.models.user import User

# 一条消息最多带几张图。识图很烧 token,也防止前端误传一大堆把上下文撑爆,
# 在入口处先卡一道。
MAX_IMAGES_PER_MESSAGE = 6

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
        req.model = default_model_id()
    elif req.model not in allowed_model_ids():
        raise HTTPException(status_code=400, detail=f"不支持的模型：{req.model}")

    # 图片校验：只在带了图时才做。
    #   1. 当前模型必须支持识图（vision）—— 否则把图发给不认图的模型只会神秘出错 / 被忽略。
    #      前端虽已把按钮置灰,但后端是安全边界,不能信任前端,这里再挡一次。
    #   2. 张数不超上限。
    #   3. 每张必须是 data:image/ 开头的 data URL —— 我们直接把它当 image_url 透传给中转,
    #      挡掉非法 / 非图片内容,避免把任意字符串塞进多模态消息。
    if req.images:
        if not models_by_id()[req.model]["vision"]:
            raise HTTPException(status_code=400, detail="当前模型不支持识图，请切换到支持识图的模型")
        if len(req.images) > MAX_IMAGES_PER_MESSAGE:
            raise HTTPException(
                status_code=400, detail=f"一次最多发送 {MAX_IMAGES_PER_MESSAGE} 张图片"
            )
        if any(not url.startswith("data:image/") for url in req.images):
            raise HTTPException(status_code=400, detail="图片格式不合法")

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

    # 额度校验（只校验、不扣费）。扣费是「成功才扣」：真正 += cost 在 agent_loop 跑完收尾处，
    # 中断 / 报错都不会扣，所以这里开跑前只需判断「今天还够不够再跑这一轮」，不够就 402。
    #   used_today 处理跨天：daily_date 不是今天就当 0（昨天的用量不算）。
    #   allowance_for 取「生效档位」的额度：付费档过了 tier_expires_at 会自动按 free 算。
    #   cost 是本轮模型的倍率（1 / 2）。
    now = datetime.now()
    cost = models_by_id()[req.model]["cost"]
    if used_today(current_user, now.date()) + cost > allowance_for(current_user, now):
        raise HTTPException(status_code=402, detail="今日额度已用完，明天恢复或升级套餐")

    # 注意：StreamingResponse 拿到的是生成器，FastAPI 会保持 db 依赖存活
    # 直到生成器耗尽（即整个 SSE 流结束），所以工具里使用 db 是安全的。
    # 把 user_id 传进去：loop 跑完干净收尾时按它扣点。
    # 外面包一层 with_heartbeat：check_build 最多等 90s，靠它保活连接
    #（ask_user 已改用 interrupt()，不会再让这条请求长时间挂起，见 app.agents.loop）。
    return StreamingResponse(
        with_heartbeat(agent_loop(req, db, current_user.id)),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


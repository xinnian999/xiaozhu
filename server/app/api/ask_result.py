"""Ask result API —— 提交 ask_user 的回答，恢复被 interrupt() 暂停的那一轮。

迁移到 LangGraph 标准 interrupt() 方案后（见 app.agents.tools 的 ask_user 工具、
app.agents.loop 里 _consume 的 __interrupt__ 分支），ask_user 触发时原来那条
/api/chat 的 SSE 流已经正常结束了 —— 没有任何请求还挂着等答案。所以这个接口不再是
旧版「204 fire-and-forget、指望旧流继续推事件」，而是自己开一条新的 SSE 流，用
Command(resume=answer) 从暂停点接着跑图，响应形状和 /api/chat 对齐。
"""

import asyncio

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from langgraph.types import Command
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agents.loop import (
    _consume,
    _file_tree_note,
    build_round_agent,
    latest_round_thread_id,
    sse,
    with_heartbeat,
)
from app.db import get_db
from app.deps import get_owned_session
from app.llm import allowed_model_ids, default_model_id
from app.models.message import Message as DBMessage
from app.models.session import Session

router = APIRouter(
    prefix="/api/sessions/{session_id}/ask-result",
    tags=["ask-result"],
)


class AskResult(BaseModel):
    """前端报回的回答。

    tool_call_id 用来匹配「checkpointer 里当前真正待答的那个」——刷新页面后失效的
    提问卡片迟到提交会因为 tool_call_id 对不上而被拒绝（见下方校验），不会误恢复成
    别的一轮。
    answer 是前端已经把所有 Tab 的 Q&A 汇总格式化好的一份文本。
    model：resume 要重新构造 llm/agent（checkpointer 只持久化图状态，不持久化这些
    运行时对象），所以模型名要由前端在提交答案时一并带上，即当前会话选中的模型。
    """

    tool_call_id: str
    answer: str
    model: str | None = None


async def _resume_stream(session_id: str, body: AskResult, db: AsyncSession, user_id: str):
    """校验 pending interrupt 后，用 Command(resume=...) 接着跑，产出 SSE 事件。

    校验失败一律用 HTTPException 表达，但此时已经在 StreamingResponse 的生成器里
    （HTTP 200 头早已发出，见 app.agents.loop.agent_loop 对同一问题的处理），异常
    不能直接向外抛出去，否则前端只会看到流凭空中断——所以这里统一 catch 住，转成
    error + done 两帧收尾。
    """
    try:
        model = body.model
        if model is None:
            model = default_model_id()
        elif model not in allowed_model_ids():
            raise HTTPException(status_code=400, detail=f"不支持的模型：{model}")

        # thread_id 与「这一轮」绑定（见 app.agents.loop 里的说明），取这个 session
        # 最新一条用户消息的 id 就能算出触发当前这轮的 thread_id。
        thread_id = await latest_round_thread_id(db, session_id)
        if thread_id is None:
            raise HTTPException(status_code=409, detail="没有可恢复的提问")

        db_lock = asyncio.Lock()
        tree_note = await _file_tree_note(db, session_id)
        agent = build_round_agent(db, session_id, model, db_lock, tree_note)

        config = {"configurable": {"thread_id": thread_id}}
        state = await agent.aget_state(config)
        if not state.interrupts:
            # 没有待恢复的 interrupt：thread 不存在 / 已经跑完被清理 / 重复提交。
            # 按「过期」统一处理，不误恢复。
            raise HTTPException(status_code=409, detail="这个提问已失效，请刷新页面")

        # 从当前图状态的最后一条消息里找出「正等着的那个 ask_user tool_call」，
        # 校验前端提交的 tool_call_id 与它一致——不一致同样按「过期」处理。
        messages = state.values.get("messages", [])
        last_msg = messages[-1] if messages else None
        ask_call = None
        for tc in getattr(last_msg, "tool_calls", None) or []:
            if tc["name"] == "ask_user" and tc["id"] == body.tool_call_id:
                ask_call = tc
                break
        if ask_call is None:
            raise HTTPException(status_code=409, detail="这个提问已失效，请刷新页面")

        # 版本快照的摘要用触发这一轮的用户消息文本（thread_id 尾部就是它的 id）。
        summary_text = ""
        try:
            last_user_id = int(thread_id.rsplit(":", 1)[1])
            row = await db.execute(
                select(DBMessage.text).where(DBMessage.id == last_user_id)
            )
            summary_text = row.scalar_one_or_none() or ""
        except (ValueError, IndexError):
            pass

        # 找到当时 _consume 为这次 ask_user 调用存的那条待补全工具消息（text 还是
        # 空的，等着这次的答案填进去），补种进 initial_pending——见 _consume 的参数
        # 说明：resume 是一次全新的 astream() 调用，"model" 节点不会重新产出这个
        # tool_call 事件，pending 字典天然是空的，不补种的话 resume 后的
        # ToolMessage 会被静默丢弃。
        result = await db.execute(
            select(DBMessage)
            .where(
                DBMessage.session_id == session_id,
                DBMessage.kind == "tool",
                DBMessage.tool_name == "ask_user",
                DBMessage.text == "",
            )
            .order_by(DBMessage.id.desc())
            .limit(1)
        )
        tool_msg = result.scalar_one_or_none()
        if tool_msg is None:
            raise HTTPException(status_code=409, detail="这个提问已失效，请刷新页面")

        async for event in _consume(
            agent,
            Command(resume=body.answer),
            thread_id,
            session_id=session_id,
            summary_text=summary_text,
            model=model,
            db=db,
            db_lock=db_lock,
            user_id=user_id,
            initial_pending={ask_call["id"]: ("ask_user", ask_call["args"], tool_msg)},
        ):
            yield event
    except HTTPException as e:
        yield sse({"type": "error", "message": str(e.detail)})
        yield sse({"type": "done"})


@router.post("")
async def report_ask_result(
    session_id: str,
    body: AskResult,
    db: AsyncSession = Depends(get_db),
    session: Session = Depends(get_owned_session),
) -> StreamingResponse:
    """恢复一轮被 ask_user 暂停的对话，返回一条新的 SSE 流（形状对齐 /api/chat）。

    会话归属由 get_owned_session 把关；顺手拿到的 session.user_id 是这一轮的原始
    请求者，传给 _consume 用于「成功才扣」的计费收尾。
    """
    return StreamingResponse(
        with_heartbeat(_resume_stream(session_id, body, db, session.user_id)),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )

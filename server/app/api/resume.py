"""Resume API —— 生成中断后从断点续跑。

用户在 AI 生成过程中刷新页面 / 手机锁屏 / 网络抖动，SSE 长连接会断，那次 astream()
被 CancelledError 打断。关键在于：LangGraph 的 checkpointer（见 app.checkpointer）在
每个图节点跑完后都会存一次检查点，而 _consume 的收尾清理 _cleanup_thread 只在正常/报错
路径跑（断连的 CancelledError 是 BaseException，不被 except Exception 捕获）——所以断连
时检查点会留存下来。

于是「续跑」= 用同一个确定性的 thread_id（见 app.agents.loop 的说明，由触发本轮的用户
消息 id 算出）重建 agent，以 None 为输入调 astream 从检查点接着跑。这和 ask_result（ask_user
的 resume）是同一套路，区别只在输入：ask_result 传 Command(resume=answer)，这里传 None
（表示「没有新输入，从上次中断的地方继续」）。

两个接口：
  - GET  /api/sessions/{id}/resume-state → {"resumable": bool}，前端据此决定是否显示
    「继续生成」按钮。
  - POST /api/sessions/{id}/resume       → 一条新的 SSE 流（形状对齐 /api/chat），续跑。
"""

import asyncio

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agents.loop import (
    _consume,
    _file_tree_note,
    build_round_agent,
    latest_round_thread_id,
    reseed_pending_from_state,
    sse,
    with_heartbeat,
)
from app.db import get_db
from app.deps import get_owned_session
from app.llm import allowed_model_ids, default_model_id
from app.models.message import Message as DBMessage
from app.models.session import Session

router = APIRouter(
    prefix="/api/sessions/{session_id}/resume",
    tags=["resume"],
)


class ResumeStart(BaseModel):
    """POST /resume 的请求体。

    model：续跑要重建 llm/agent（checkpointer 只持久化图状态，不持久化运行时对象），
    模型名由前端带上，即当前会话选中的模型。不传就用默认模型。
    """

    model: str | None = None


@router.get("-state")
async def resume_state(
    session_id: str,
    db: AsyncSession = Depends(get_db),
    session: Session = Depends(get_owned_session),
) -> dict:
    """探测这个会话最新一轮是否「可续跑」。

    resumable = 有检查点且还有未跑完的节点(state.next 非空) 且 不是 ask_user 暂停
    (state.interrupts 为空——那种情况走既有的 ask_user 提问流程，不在这里报可续)。
    无检查点 / 已正常跑完被清理 → next 为空 → resumable=False。
    """
    thread_id = await latest_round_thread_id(db, session_id)
    if thread_id is None:
        return {"resumable": False}

    # 读状态要构造 agent（aget_state 挂在编译好的图上）。模型用默认即可——这里只读
    # next/interrupts，不真正跑图，模型是谁不影响判断。
    db_lock = asyncio.Lock()
    tree_note = await _file_tree_note(db, session_id)
    try:
        agent = build_round_agent(db, session_id, default_model_id(), db_lock, tree_note)
        state = await agent.aget_state({"configurable": {"thread_id": thread_id}})
    except Exception:
        # 读状态失败（检查点损坏等）一律当「不可续」，不影响主流程
        return {"resumable": False}

    resumable = bool(state.next) and not state.interrupts
    return {"resumable": resumable}


async def _resume_stream(session_id: str, body: ResumeStart, db: AsyncSession, user_id: str):
    """校验可续后，以 None 为输入从检查点续跑，产出 SSE 事件。

    校验失败用 HTTPException 表达，但此时已在 StreamingResponse 生成器里（HTTP 200 头早已
    发出），异常不能外抛，否则前端只看到流凭空中断——统一 catch 转成 error + done 两帧。
    """
    try:
        model = body.model
        if model is None:
            model = default_model_id()
        elif model not in allowed_model_ids():
            raise HTTPException(status_code=400, detail=f"不支持的模型：{model}")

        thread_id = await latest_round_thread_id(db, session_id)
        if thread_id is None:
            raise HTTPException(status_code=409, detail="没有可续跑的任务")

        db_lock = asyncio.Lock()
        tree_note = await _file_tree_note(db, session_id)
        agent = build_round_agent(db, session_id, model, db_lock, tree_note)

        # 再校验一次可续（并发/重复点击兜底）：有检查点、有待跑节点、且不是 ask_user 暂停。
        state = await agent.aget_state({"configurable": {"thread_id": thread_id}})
        if not state.next or state.interrupts:
            raise HTTPException(status_code=409, detail="这个任务已完成或已失效，请刷新页面")

        # 版本快照摘要用触发这一轮的用户消息文本（thread_id 尾部就是它的 id）。
        summary_text = ""
        try:
            last_user_id = int(thread_id.rsplit(":", 1)[1])
            row = await db.execute(
                select(DBMessage.text).where(DBMessage.id == last_user_id)
            )
            summary_text = row.scalar_one_or_none() or ""
        except (ValueError, IndexError):
            pass

        # 断连时可能正卡在 tools 节点（check_build/write_file 还没回结果）：把这些「已发起
        # 未完成」的 tool_call 补种进 pending，否则续跑后 tools 节点回传的 ToolMessage 会被
        # 静默丢弃（见 _consume 的 initial_pending 说明 / reseed_pending_from_state）。
        initial_pending = await reseed_pending_from_state(db, session_id, state)

        # 输入传 None：LangGraph 对「有检查点且 next 非空」的 thread 以 None 输入即从断点
        # 继续（区别于 ask_result 的 Command(resume=answer)）。收尾三件套（存最终文本 / 版本
        # 快照 / 计费 / 清检查点）由 _consume 复用，天然只算一次账。
        async for event in _consume(
            agent,
            None,
            thread_id,
            session_id=session_id,
            summary_text=summary_text,
            model=model,
            db=db,
            db_lock=db_lock,
            user_id=user_id,
            initial_pending=initial_pending,
        ):
            yield event
    except HTTPException as e:
        yield sse({"type": "error", "message": str(e.detail)})
        yield sse({"type": "done"})


@router.post("")
async def start_resume(
    session_id: str,
    body: ResumeStart,
    db: AsyncSession = Depends(get_db),
    session: Session = Depends(get_owned_session),
) -> StreamingResponse:
    """从断点续跑被中断的那一轮，返回一条新的 SSE 流（形状对齐 /api/chat）。

    会话归属由 get_owned_session 把关；session.user_id 是这一轮的原始请求者，传给 _consume
    用于「成功才扣」的计费收尾。
    """
    return StreamingResponse(
        with_heartbeat(_resume_stream(session_id, body, db, session.user_id)),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )

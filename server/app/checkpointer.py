"""LangGraph checkpointer 单例 —— 给 ask_user 的 interrupt()/resume 用。

ask_user 工具内部调用 interrupt()（见 app.agents.tools），LangGraph 要求必须挂一个
checkpointer 才能用这个原语：interrupt() 触发时，图的完整状态（含 messages）会被
存进这个 checkpointer，同时结束当前这次 astream() 调用（HTTP 请求随之正常关闭，
不再有任何请求挂着等真人回答）；等前端把回答 POST 回来，用 Command(resume=answer)
配同一个 thread_id 重新发起一次独立的 astream() 调用，就能从暂停点接着跑。

生命周期挂在 app.main 的 lifespan：启动时 open + setup()（建表，幂等）+
set_checkpointer() 存起来；shutdown 时随 lifespan 的 async with 自然关闭。
业务代码只用 get_checkpointer() 读，不关心它何时被创建。
"""

from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.message import Message as DBMessage

_checkpointer: AsyncSqliteSaver | None = None


def set_checkpointer(cp: AsyncSqliteSaver) -> None:
    """lifespan 启动时调用一次，把打开好的 checkpointer 存成模块级单例。"""
    global _checkpointer
    _checkpointer = cp


def get_checkpointer() -> AsyncSqliteSaver:
    """业务代码（agent_loop / ask_result 路由）取用 checkpointer。"""
    if _checkpointer is None:
        raise RuntimeError("checkpointer 尚未初始化：lifespan 是否还没跑完？")
    return _checkpointer


async def delete_session_checkpoints(
    db: AsyncSession,
    session_id: str,
) -> None:
    """删除会话前清掉它所有用户轮次的 LangGraph 临时状态。"""
    result = await db.execute(
        select(DBMessage.id).where(
            DBMessage.session_id == session_id,
            DBMessage.role == "user",
            DBMessage.kind == "text",
        )
    )
    for message_id in result.scalars().all():
        await get_checkpointer().adelete_thread(f"{session_id}:{message_id}")

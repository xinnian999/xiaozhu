"""Sessions API —— 会话的增查接口。

这里展示了 FastAPI + SQLAlchemy async 的标准写法：
  1. 用 APIRouter 把路由分组，在 main.py 里 include 进来（类似 Flask Blueprint）。
  2. 用 Depends(get_db) 注入数据库 session，无需手动 open/close。
  3. 所有数据库操作都要 await（因为我们用的是 async SQLAlchemy）。
"""

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.deps import get_current_user, get_owned_session
from app.models.file import File
from app.models.session import Session, SessionCreate, SessionRead
from app.models.user import User
from app.templates import load_template

# prefix="/api/sessions" → 这个 router 里所有路由都以 /api/sessions 开头
router = APIRouter(prefix="/api/sessions", tags=["sessions"])


@router.post("", response_model=SessionRead, status_code=201)
async def create_session(
    body: SessionCreate,
    db: AsyncSession = Depends(get_db),  # FastAPI 自动注入
    current_user: User = Depends(get_current_user),  # 必须登录才能建会话
) -> SessionRead:
    """创建一个新会话，并把 Vite + React 模板预置进去，返回完整的 session 对象。

    为什么要预置模板？因为 WebContainer 启动需要一个完整可跑的项目骨架
    （package.json / vite.config.ts / index.html ...），让 LLM 从零生成
    这些配置文件容易出错且浪费 token，干脆固定下来。
    LLM 只负责改 src/ 下的业务代码。

    SQLAlchemy async 的操作流程：
      1. 创建 ORM 对象
      2. db.add() —— 加入当前 session 的"待写入队列"
      3. db.flush() —— 推 SQL 到数据库但不 commit，目的是先拿到 session.id
         好让接下来批量插入的 File 拿到外键
      4. await db.commit() —— 真正提交事务
      5. await db.refresh(obj) —— 从数据库重新读一次，拿到 server_default 填充的字段
    """
    # user_id 来自 token 解出的当前用户，绝不从请求体取 ——
    # 否则前端可以伪造别人的 user_id 把会话挂到别人名下。
    session = Session(title=body.title, user_id=current_user.id)
    db.add(session)
    await db.flush()  # 拿到 session.id，准备给 files 当外键

    # 把模板文件批量塞进 files 表
    template_files = load_template("vite-react")
    db.add_all([
        File(session_id=session.id, path=path, content=content)
        for path, content in template_files.items()
    ])

    await db.commit()
    await db.refresh(session)  # 拿到数据库生成的 created_at / updated_at
    return SessionRead.model_validate(session)


@router.get("", response_model=list[SessionRead])
async def list_sessions(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[SessionRead]:
    """返回**当前用户自己的**会话，按创建时间倒序（最新的在前）。

    关键就是 .where(Session.user_id == current_user.id) 这个过滤条件 ——
    多用户隔离的核心：每次查询都按当前用户收窄，绝不返回别人的数据。
    """
    result = await db.execute(
        select(Session)
        .where(Session.user_id == current_user.id)
        .order_by(Session.created_at.desc())
    )
    sessions = result.scalars().all()  # scalars() 把每行的第一列取出来，即 Session 对象
    return [SessionRead.model_validate(s) for s in sessions]


@router.get("/{session_id}", response_model=SessionRead)
async def get_session(
    session: Session = Depends(get_owned_session),
) -> SessionRead:
    """按 ID 查询会话；不存在、或不属于当前用户，都返回 404。

    归属校验全部交给 get_owned_session 守卫完成（它内部按 id + user_id 过滤，
    查不到就抛 404）。所以这里函数体只剩「把拿到的会话转成响应」一行，
    既消除了重复查询，又和子资源接口用的是同一套归属逻辑。
    """
    return SessionRead.model_validate(session)

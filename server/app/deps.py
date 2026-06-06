"""可复用的 FastAPI 依赖（Dependencies）。

目前只有一个：get_current_user —— 「拿到当前登录用户」。
任何需要登录才能访问的接口，只要在参数里写：
    user: User = Depends(get_current_user)
FastAPI 就会在进入函数体之前，自动完成「取 token → 验签 → 查用户」，
验证不过直接返回 401，根本进不到你的业务代码。这就是依赖注入的威力：
鉴权逻辑写一次，到处复用，业务函数拿到的永远是「已登录的合法用户」。
"""

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.models.session import Session
from app.models.user import User
from app.security import decode_access_token

# HTTPBearer 是 FastAPI 内置的「安全方案」，负责从请求头里抠出
#   Authorization: Bearer <token>
# 的 <token> 部分。
#   - auto_error=True：头缺失或格式不对时，它自己就抛 403/401，不用我们判。
#   - 额外好处：Swagger 文档（/docs）右上角会出现「Authorize」按钮，可填 token 调试。
bearer_scheme = HTTPBearer(auto_error=True)


async def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(bearer_scheme),
    db: AsyncSession = Depends(get_db),
) -> User:
    """从请求里解析出当前登录用户；任何一步失败都抛 401。"""
    # 统一的 401。WWW-Authenticate: Bearer 是 HTTP 标准，告诉客户端「该用 Bearer 方式认证」。
    credentials_exc = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="无效或已过期的凭证",
        headers={"WWW-Authenticate": "Bearer"},
    )

    token = credentials.credentials  # HTTPBearer 已经帮我们去掉了 "Bearer " 前缀
    try:
        user_id = decode_access_token(token)
    except jwt.ExpiredSignatureError:
        # 单独分一个分支，给前端更明确的提示，方便它引导用户重新登录
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="登录已过期，请重新登录",
            headers={"WWW-Authenticate": "Bearer"},
        ) from None
    except jwt.PyJWTError:
        # 签名不对、格式损坏、被篡改等所有其它 JWT 错误，统一当无效凭证
        raise credentials_exc from None

    # token 本身有效，但仍要确认这个用户现在还存在（可能已被删号）
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if user is None:
        raise credentials_exc
    return user


async def get_owned_session(
    session_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Session:
    """校验「路径里的 session_id 确实属于当前登录用户」，是则返回该会话，否则 404。

    这是一个「会话归属守卫」。所有挂在 /api/sessions/{session_id}/... 下的子资源
    （files / messages / versions / logs）都共用它来防止越权访问别人的会话数据。

    用法有两种：
      1. 路由级（推荐）：APIRouter(dependencies=[Depends(get_owned_session)])，
         该 router 下每个接口进来前都先过这道守卫，函数体不用改。FastAPI 会自动
         从路径里取出 session_id 注入进来。
      2. 函数级：把 session: Session = Depends(get_owned_session) 写进参数，
         既做了校验，又顺手拿到会话对象（get_session 就是这么用的）。

    返回 404 而非 403 的理由同 get_session：不向越权者泄露会话是否存在。
    """
    result = await db.execute(
        select(Session).where(
            Session.id == session_id,
            Session.user_id == current_user.id,
        )
    )
    session = result.scalar_one_or_none()
    if session is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Session not found")
    return session

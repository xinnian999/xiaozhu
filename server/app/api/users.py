"""Users API —— 第 1 步只做「注册」。

登录接口（POST /api/users/login）会在第 2 步加进来，那时再处理签发 token。
"""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.deps import get_current_user
from app.mock_profile import random_avatar_seed, random_nickname
from app.models.user import Token, User, UserCreate, UserLogin, UserRead, UserUpdate
from app.security import create_access_token, hash_password, verify_password

router = APIRouter(prefix="/api/users", tags=["users"])


@router.post("/register", response_model=UserRead, status_code=201)
async def register(
    body: UserCreate,
    db: AsyncSession = Depends(get_db),
) -> UserRead:
    """注册一个新用户。

    流程：
      1. 先查这个邮箱是否已被注册 → 已存在则返回 409 Conflict。
         （DB 的 unique 约束是最后兜底，但我们主动查一次能给前端更友好的报错。）
      2. 把明文密码哈希掉，绝不入库明文。
      3. 创建 User、提交、刷新拿到 created_at。
      4. 返回 UserRead —— 它不含 password_hash，密码哈希不会泄露给前端。
    """
    # 1. 邮箱查重
    result = await db.execute(select(User).where(User.email == body.email))
    if result.scalar_one_or_none() is not None:
        raise HTTPException(status_code=409, detail="该邮箱已被注册")

    # 2~3. 哈希密码并入库，同时随机生成一个文艺昵称和头像种子
    user = User(
        email=body.email,
        password_hash=hash_password(body.password),
        nickname=random_nickname(),
        avatar=random_avatar_seed(),
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)  # 拿到数据库生成的 created_at

    # 4. response_model=UserRead 会自动把 ORM 对象转成只含安全字段的 JSON
    return user


@router.post("/login", response_model=Token)
async def login(
    body: UserLogin,
    db: AsyncSession = Depends(get_db),
) -> Token:
    """登录：邮箱 + 密码换一个 JWT。

    流程：
      1. 按邮箱查用户。
      2. 校验密码：把这次输入的明文用 bcrypt 和库里哈希比对。
      3. 任意一步失败都返回**同一个** 401「邮箱或密码错误」——
         故意不区分「用户不存在」和「密码错」，避免攻击者拿这个接口探测
         「哪些邮箱注册过」（这叫 user enumeration，账号枚举）。
      4. 成功 → 签发 JWT 返回。前端拿到后存起来，以后每次请求带上它。
    """
    # 1. 查用户
    result = await db.execute(select(User).where(User.email == body.email))
    user = result.scalar_one_or_none()

    # 2~3. 用户不存在 或 密码不对 → 统一 401
    if user is None or not verify_password(body.password, user.password_hash):
        raise HTTPException(status_code=401, detail="邮箱或密码错误")

    # 4. 签发 token
    access_token = create_access_token(user.id)
    return Token(access_token=access_token)


@router.get("/me", response_model=UserRead)
async def me(current_user: User = Depends(get_current_user)) -> User:
    """返回「当前登录用户」自己的信息。

    注意这个函数体里**没有任何鉴权代码** —— 取 token、验签、查用户全在
    Depends(get_current_user) 里做完了。函数一旦被执行，current_user 必然是
    一个合法的已登录用户；否则请求早就被 401 挡在外面了。
    这就是把鉴权抽成依赖的意义：业务接口只管业务。
    """
    return current_user


@router.patch("/me", response_model=UserRead)
async def update_me(
    body: UserUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> User:
    """修改当前用户的资料（昵称 / 头像）。

    partial update：只改请求里传了的字段，没传的（None）保持不变。
    current_user 是 get_current_user 从「同一个请求 db 会话」里查出来的 ORM 对象，
    所以直接改它的属性再 commit 就能落库，不需要重新 select。
    """
    if body.nickname is not None:
        current_user.nickname = body.nickname
    if body.avatar is not None:
        current_user.avatar = body.avatar
    await db.commit()
    await db.refresh(current_user)
    return current_user

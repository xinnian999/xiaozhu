"""Users API —— 第 1 步只做「注册」。

登录接口（POST /api/users/login）会在第 2 步加进来，那时再处理签发 token。
"""

import secrets
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.deps import get_current_user
from app.email import send_verify_code
from app.mock_profile import random_avatar_seed, random_nickname
from app.models.email_code import EmailCode
from app.models.user import (
    SendCodeRequest,
    Token,
    User,
    UserCreate,
    UserLogin,
    UserRead,
    UserUpdate,
)
from app.security import create_access_token, hash_password, verify_password

router = APIRouter(prefix="/api/users", tags=["users"])

# 验证码相关常量
CODE_TTL = timedelta(minutes=10)         # 验证码有效期
RESEND_INTERVAL = timedelta(seconds=60)  # 两次发码最小间隔（防刷邮件 / 防当轰炸机）
MAX_VERIFY_ATTEMPTS = 5                   # 验证码最多验几次（防爆破），超了作废


@router.post("/send-code", status_code=204)
async def send_code(
    body: SendCodeRequest,
    db: AsyncSession = Depends(get_db),
) -> Response:
    """给注册用的邮箱发一封验证码。

    流程：① 已注册的邮箱不发（顺带避免骚扰已有用户）；② 同邮箱 60 秒限频，防刷；
    ③ 生成 6 位码、覆盖旧码、归零尝试次数；④ 先把邮件发出去，发成功了才落库
    （发失败就不 commit、get_db 自动回滚，用户能立即重试，不会被卡在限频里）。
    """
    email = body.email
    now = datetime.now()

    # ① 已注册的邮箱不发码
    result = await db.execute(select(User).where(User.email == email))
    if result.scalar_one_or_none() is not None:
        raise HTTPException(status_code=409, detail="该邮箱已被注册")

    # ② 发送限频：同邮箱 60 秒内只能发一次
    existing = await db.get(EmailCode, email)
    if existing is not None and now - existing.sent_at < RESEND_INTERVAL:
        raise HTTPException(status_code=429, detail="发送过于频繁，请稍后再试")

    # ③ 生成 6 位码并准备落库（secrets：密码学安全随机，别用 random）。先不 commit。
    code = f"{secrets.randbelow(1_000_000):06d}"
    if existing is None:
        existing = EmailCode(email=email)
        db.add(existing)
    existing.code = code
    existing.expires_at = now + CODE_TTL
    existing.attempts = 0
    existing.sent_at = now

    # ④ 先发邮件，发成功才 commit（发失败抛错 → 不落库 → 用户可立即重试）
    await send_verify_code(email, code)
    await db.commit()
    return Response(status_code=204)


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

    # 1.5 校验邮箱验证码：必须先 send-code 拿到、没过期、没被试爆、且对得上。
    #     这一步保证「能收到码的真实邮箱」才建得了号 —— 一个真邮箱一个号。
    rec = await db.get(EmailCode, body.email)
    now = datetime.now()
    if rec is None or rec.expires_at < now:
        raise HTTPException(status_code=400, detail="验证码无效或已过期，请重新获取")
    if rec.attempts >= MAX_VERIFY_ATTEMPTS:
        raise HTTPException(status_code=400, detail="验证码错误次数过多，请重新获取")
    # compare_digest：定长时间比较，避免计时侧信道（配合 attempts 上限双保险）
    if not secrets.compare_digest(rec.code, body.code):
        rec.attempts += 1  # 记一次失败，超限即作废
        await db.commit()
        raise HTTPException(status_code=400, detail="验证码错误")
    # 验证通过：删掉这条码（一次性，用完即弃），与下面建号在同一事务里提交
    await db.delete(rec)

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

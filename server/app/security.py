"""安全相关的工具函数。

第 1 步只放「密码哈希」这一对函数。
第 2 步做登录时，JWT 的签发/校验也会加到这个文件里。

为什么单独抽一个 security.py，而不写在路由里？
  路由（api/）只负责「收请求、调逻辑、回响应」，
  真正的安全逻辑（哈希、签名）独立成模块，将来登录、改密码都能复用同一套。
"""

from datetime import datetime, timedelta, timezone

import bcrypt
import jwt

from app.config import settings


def hash_password(password: str) -> str:
    """把明文密码哈希成可以安全入库的字符串。

    bcrypt 的两步：
      1. gensalt()  —— 生成随机「盐」。括号里可传 rounds（成本因子），默认 12，
         数字越大算得越慢、越难暴力破解，但登录也越慢。12 是业界常用平衡点。
      2. hashpw()   —— 把「密码 + 盐」一起哈希。返回值里已经包含了盐和成本因子，
         形如 $2b$12$xxxxxxxxxxxxxxxxxxxxxx，所以入库只存这一个字段就够。

    注意编码：bcrypt 只认 bytes，所以 str 要先 .encode("utf-8")；
    存进数据库我们想要 str，所以结果再 .decode("utf-8") 转回来。
    """
    # bcrypt 有个历史限制：密码超过 72 字节的部分会被忽略（5.x 起直接报错）。
    # 我们在 UserCreate schema 里用 max_length=72 卡住，这里就不会触发。
    salt = bcrypt.gensalt()
    hashed = bcrypt.hashpw(password.encode("utf-8"), salt)
    return hashed.decode("utf-8")


def verify_password(password: str, password_hash: str) -> bool:
    """校验「用户这次输入的明文」和「库里存的哈希」是否匹配。

    checkpw() 会从 password_hash 里读出当初用的盐和成本因子，
    用同样的参数把传入的明文再哈希一遍，再做「防时序攻击」的安全比较。
    我们自己不需要、也无法手动取出盐——这正是 bcrypt 把盐编码进结果的好处。
    """
    return bcrypt.checkpw(password.encode("utf-8"), password_hash.encode("utf-8"))


# ── JWT 签发 / 验签 ──────────────────────────────────────────────────────────────


def create_access_token(user_id: str) -> str:
    """给指定用户签发一个 JWT，登录成功后返回给前端。

    payload 里放两样东西：
      - sub（subject）：JWT 标准字段，习惯放「这个 token 代表谁」，我们放 user_id。
        ⚠️ payload 只是 base64 编码、不是加密，任何人都能解开看见，所以只放 id 这种
        非敏感标识，绝不放密码。
      - exp（expiration）：标准字段，过期时间戳。PyJWT 在「解码」时会自动检查它，
        过期会直接抛 ExpiredSignatureError —— 我们不用自己写过期判断。

    jwt.encode(payload, 密钥, 算法)：
      用密钥按 HS256 算出签名，拼成 header.payload.signature 三段字符串。
      密钥只有服务端有，所以别人改了 payload 也算不出正确签名 → 防伪造。
    """
    expire = datetime.now(timezone.utc) + timedelta(minutes=settings.access_token_expire_minutes)
    payload = {"sub": user_id, "exp": expire}
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def decode_access_token(token: str) -> str:
    """验证一个 JWT，返回它代表的 user_id（payload 里的 sub）。

    jwt.decode() 一步做完三件事，任意一件不过都会抛异常：
      - 用密钥按指定算法**重算签名并比对** → 签名不符抛 InvalidSignatureError
      - 检查 exp 是否过期 → 过期抛 ExpiredSignatureError
      - 解析 payload

    这里我们**只验签、只抛异常**，不自己转成 HTTP 错误 ——
    把异常留给上层的鉴权依赖（deps.py）去翻译成 401，保持「纯逻辑」和「Web 层」分离。

    algorithms 必须用列表显式指定，且不能包含 "none"：
      历史上有种攻击是把 token 的 alg 改成 "none"（无签名）来绕过验证，
      显式只允许我们自己的算法就堵死了这条路。
    """
    payload = jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
    user_id = payload.get("sub")
    if not user_id:
        # 签名虽然有效，但 payload 结构不对（缺 sub），同样视为无效凭证
        raise jwt.InvalidTokenError("token 缺少 sub 字段")
    return user_id

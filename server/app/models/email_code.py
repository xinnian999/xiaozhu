"""EmailCode（注册邮箱验证码）的数据模型。

注册流程改成「先发码 → 验码通过才建号」。验证码必须落库，不能只放内存：
  - 容器重启 / 多进程会丢内存数据；
  - 发码请求和验码请求可能落到不同 worker。
一个邮箱同一时刻只需保留「最新一条」验证码，所以直接用 email 作主键 —— 重发就覆盖旧的，
天然去重、查询 O(1)。
"""

from datetime import datetime

from sqlalchemy import DateTime, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class EmailCode(Base):
    """数据库表 `email_codes`：临时存「邮箱 → 验证码」，用完即删。"""

    __tablename__ = "email_codes"

    # 邮箱作主键：一个邮箱只保留一条最新验证码（重发即覆盖，无需额外去重）
    email: Mapped[str] = mapped_column(String, primary_key=True)

    # 6 位数字码。存明文即可——它短时有效、用完即删，不是长期凭证（和密码哈希不同）。
    code: Mapped[str] = mapped_column(String, nullable=False)

    # 过期时间（发码时 = 现在 + 10 分钟）。验码时超过这个点就算无效。
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)

    # 已尝试验证的次数：防爆破。超过上限就作废，必须重新获取验证码。
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")

    # 最近一次发送时间：用于「发送限频」（如 60 秒内不许重复发，防刷邮件 / 防被人当短信轰炸机）。
    sent_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=func.now()
    )

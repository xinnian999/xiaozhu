"""BootFailure（预览运行环境 boot 结果上报）的数据模型。

WebContainer 的运行时要从境外（StackBlitz）boot 下来，国内网络偶发失败/超时、或很慢。
前端把每次 boot 的结果上报到这里——**成功也报**（kind='ok' + 耗时），失败也报（timeout/error），
管理后台据此统计 boot 耗时分布、监控失败率、定位偶发原因（网络超时 / 缺 COOP/COEP / 慢链路）。

表名沿用 boot_failures（历史原因），但现在既存成功也存失败；后台统计失败数时按 kind != 'ok' 过滤。

best-effort 旁路数据：上报失败不影响用户，写不进也无所谓，所以表结构从简、不设外键约束
（session_id / user_id 可空，失败可能发生在会话建立前）。
"""

from datetime import datetime, timezone

from sqlalchemy import DateTime, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class BootFailure(Base):
    """数据库表 `boot_failures`：记录一次预览运行环境 boot 的结果（成功耗时 / 失败原因）。"""

    __tablename__ = "boot_failures"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)

    # 失败发生时用户所在的会话 / 用户身份。都可空：boot 可能在会话尚未建立时就失败。
    # 不设 ForeignKey —— 这是旁路监控数据，不该因为会话被删就联动删除，也不想被外键约束卡住写入。
    session_id: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    user_id: Mapped[str | None] = mapped_column(String, nullable=True, index=True)

    # 卡在哪个阶段：booting / mounting / installing / building / starting。
    # 绝大多数境外依赖问题卡在 booting，但留字段以便区分「boot 成功了、后面某步才失败」。
    stage: Mapped[str] = mapped_column(String, nullable=False, server_default="booting")

    # boot 结果类型：ok（成功，记录耗时用）/ timeout（超时兜底触发）/ error（boot 抛异常）。
    # 表名虽叫 boot_failures，但也存成功记录（kind='ok'）以统计成功 boot 的耗时分布——
    # 后台的「失败数」统计一律排除 kind='ok'，失败明细表也不列成功记录，语义不受影响。
    kind: Mapped[str] = mapped_column(String, nullable=False, server_default="error")

    # 失败信息摘要（异常 message / 超时说明）。可能较长，用 Text。
    message: Mapped[str] = mapped_column(Text, nullable=False, server_default="")

    # 环境快照，帮助定位偶发原因：
    #   crossOriginIsolated —— 为 false 说明 COOP/COEP 没生效，SharedArrayBuffer 不可用，必失败。
    cross_origin_isolated: Mapped[bool | None] = mapped_column(nullable=True)
    # 卡了多少毫秒（成功 = boot 耗时；超时 = 超时阈值；异常 = 抛错前耗时）。boot 耗时统计的核心字段。
    elapsed_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # 是否「冷 boot」：本浏览器会话里第一次 boot（运行时/依赖都没缓存，最慢）。用来把冷/热 boot 分开统计耗时。
    cold: Mapped[bool | None] = mapped_column(nullable=True)
    # 预留：是否来自某种「提前 boot」预热。当前无人写入（prewarm 方案已撤），保留列以兼容库结构。
    prewarm: Mapped[bool] = mapped_column(nullable=False, server_default="0")
    # 浏览器 UA，判断是不是某些浏览器/环境特有的问题。
    user_agent: Mapped[str | None] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


# ── Pydantic Schemas ───────────────────────────────────────────────────────────

from pydantic import BaseModel, field_serializer  # noqa: E402


class BootFailureReport(BaseModel):
    """前端上报的 boot 失败负载。字段都可选，尽量宽松，别让上报本身失败。"""

    session_id: str | None = None
    stage: str = "booting"
    kind: str = "error"
    message: str = ""
    cross_origin_isolated: bool | None = None
    elapsed_ms: int | None = None
    cold: bool | None = None


class BootFailureAdminRead(BaseModel):
    """管理后台列表响应。user_id / session_id 这类裸 id 看了没意义，
    改为附带用户昵称 + 邮箱（下面两个字段由 API join User 填充，不在 boot_failures 表里）。"""

    model_config = {"from_attributes": True}

    id: int
    session_id: str | None
    user_id: str | None
    # 由 API join users 表填充：该 boot 记录所属用户的昵称 / 邮箱（用户已删或匿名时为 None）。
    user_nickname: str | None = None
    user_email: str | None = None
    stage: str
    kind: str
    message: str
    cross_origin_isolated: bool | None
    elapsed_ms: int | None
    cold: bool | None
    user_agent: str | None
    created_at: datetime

    @field_serializer("created_at")
    def serialize_created_at(self, dt: datetime) -> str:
        """把 created_at 序列化成带 UTC 时区的 ISO 字符串。

        DB 里存的是 naive（无时区）的 UTC 时间（SQLite 的 func.now() 返回 UTC）。
        直接序列化会得到 "2026-07-08T02:18:00"，没有时区后缀，前端 dayjs / new Date()
        会误当成本地时间，导致后台显示的时间比真实早/晚一个时区（东八区差 8 小时）。
        这里补上 UTC 时区 → "...+00:00"，前端就能正确换算到本地。与 message 等其他表一致。
        """
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.isoformat()

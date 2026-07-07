"""BootFailure（预览运行环境 boot 失败上报）的数据模型。

WebContainer 的运行时要从境外（StackBlitz）boot 下来，国内网络偶发失败/超时。
前端 boot 失败时把「为什么失败 + 环境信息」上报到这里，管理后台据此监控失败率、
定位偶发原因（是网络超时、还是浏览器缺 COOP/COEP、还是别的）。

best-effort 旁路数据：上报失败不影响用户，写不进也无所谓，所以表结构从简、不设外键约束
（session_id / user_id 可空，失败可能发生在会话建立前）。
"""

from datetime import datetime

from sqlalchemy import DateTime, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class BootFailure(Base):
    """数据库表 `boot_failures`：记录一次预览运行环境启动失败。"""

    __tablename__ = "boot_failures"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)

    # 失败发生时用户所在的会话 / 用户身份。都可空：boot 可能在会话尚未建立时就失败。
    # 不设 ForeignKey —— 这是旁路监控数据，不该因为会话被删就联动删除，也不想被外键约束卡住写入。
    session_id: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    user_id: Mapped[str | None] = mapped_column(String, nullable=True, index=True)

    # 卡在哪个阶段：booting / mounting / installing / building / starting。
    # 绝大多数境外依赖问题卡在 booting，但留字段以便区分「boot 成功了、后面某步才失败」。
    stage: Mapped[str] = mapped_column(String, nullable=False, server_default="booting")

    # 失败类型：timeout（超时兜底触发）/ error（boot 抛异常）。供后台快速分类。
    kind: Mapped[str] = mapped_column(String, nullable=False, server_default="error")

    # 失败信息摘要（异常 message / 超时说明）。可能较长，用 Text。
    message: Mapped[str] = mapped_column(Text, nullable=False, server_default="")

    # 环境快照，帮助定位偶发原因：
    #   crossOriginIsolated —— 为 false 说明 COOP/COEP 没生效，SharedArrayBuffer 不可用，必失败。
    cross_origin_isolated: Mapped[bool | None] = mapped_column(nullable=True)
    # 卡了多少毫秒才判失败（超时场景 = 超时阈值；异常场景 = 抛错前耗时）。
    elapsed_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # 浏览器 UA，判断是不是某些浏览器/环境特有的问题。
    user_agent: Mapped[str | None] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


# ── Pydantic Schemas ───────────────────────────────────────────────────────────

from pydantic import BaseModel  # noqa: E402


class BootFailureReport(BaseModel):
    """前端上报的 boot 失败负载。字段都可选，尽量宽松，别让上报本身失败。"""

    session_id: str | None = None
    stage: str = "booting"
    kind: str = "error"
    message: str = ""
    cross_origin_isolated: bool | None = None
    elapsed_ms: int | None = None


class BootFailureAdminRead(BaseModel):
    """管理后台列表响应，字段与表结构一一对应。"""

    model_config = {"from_attributes": True}

    id: int
    session_id: str | None
    user_id: str | None
    stage: str
    kind: str
    message: str
    cross_origin_isolated: bool | None
    elapsed_ms: int | None
    user_agent: str | None
    created_at: datetime

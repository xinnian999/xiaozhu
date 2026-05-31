"""Version（版本快照）的数据模型：ORM 表 + Pydantic Schema。

版本管理采用「整快照」模型：每次 AI 生成一轮结束，就把当时 files 表里所有文件
完整复制一份，作为一个不可变的历史版本，将来可以回滚到任意一版。

这里是经典的「一对多」关系建模，用两张表表达：

    sessions  ──1:N──>  versions  ──1:N──>  version_files
    (会话)              (一个版本)           (该版本下每个文件一行)

  - versions：版本的「元信息」——属于哪个会话、是第几版、什么时候建的。
  - version_files：版本的「内容」——每个版本的每个文件存一行，靠 version_id 外键
    指回所属版本。这就是关系数据库表达「一个版本拥有多个文件」的标准做法。

为什么不把文件塞进 versions 表的一个 JSON 字段？
  那样是「反范式」的：文件本来是多条独立记录，硬塞成一个 JSON 字符串后，
  数据库就没法对单个文件做查询/约束了。拆成 version_files 才是关系型该有的样子。

注意：现有的 files 表不动，它仍代表「当前工作副本」（WebContainer 挂载、可编辑的那份）。
versions / version_files 是它之上的历史层，回滚时把某个快照覆盖回 files 即可。
"""

from datetime import datetime

from pydantic import BaseModel
from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


# ── ORM Model ──────────────────────────────────────────────────────────────────


class Version(Base):
    """一个版本的元信息。`versions` 表。"""

    __tablename__ = "versions"

    # 自增整数主键
    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)

    # 外键关联 sessions.id —— 这个版本属于哪个会话
    session_id: Mapped[str] = mapped_column(String, ForeignKey("sessions.id"), nullable=False)

    # 版本序号：同一会话内从 1 递增（v1、v2、v3…），用于排序和给用户看的标签。
    # 它和自增主键 id 不同：id 是全局唯一的行号，seq 是「会话内第几版」。
    seq: Mapped[int] = mapped_column(Integer, nullable=False)

    # 版本摘要：一句话描述这版干了啥（比如那轮用户的需求），可空。
    # 列表 UI 会用它给每个版本配个说明，先留着，生成时再填。
    summary: Mapped[str | None] = mapped_column(String, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    # 同一会话内 seq 唯一 —— 不会出现两个 v3
    __table_args__ = (UniqueConstraint("session_id", "seq", name="uq_session_seq"),)


class VersionFile(Base):
    """某个版本快照里的单个文件。`version_files` 表。

    结构和 files 表几乎一样，但外键指向的是 versions.id 而非 sessions.id ——
    因为它属于「某一版」，而不是「当前状态」。内容是写死的历史，永不再改。
    """

    __tablename__ = "version_files"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)

    # 外键关联 versions.id —— 这个文件属于哪个版本
    version_id: Mapped[int] = mapped_column(Integer, ForeignKey("versions.id"), nullable=False)

    # 文件路径，如 "src/App.tsx"
    path: Mapped[str] = mapped_column(String, nullable=False)

    # 文件内容快照
    content: Mapped[str] = mapped_column(Text, nullable=False)

    # 同一版本内 path 唯一 —— 一个版本里不会有两个 src/App.tsx
    __table_args__ = (UniqueConstraint("version_id", "path", name="uq_version_path"),)


# ── Pydantic Schemas ───────────────────────────────────────────────────────────
# 列表接口只返回版本元信息，不带文件内容（content 可能很大，列表里用不上），
# 所以这里先只定义 VersionRead。回滚接口要用到文件内容时，再补对应 schema。


class VersionRead(BaseModel):
    """API 响应里返回的版本对象（不含文件内容）。"""
    model_config = {"from_attributes": True}  # 允许从 ORM 对象直接构建

    id: int
    session_id: str
    seq: int
    summary: str | None
    created_at: datetime

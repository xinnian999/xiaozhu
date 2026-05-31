"""版本快照逻辑 —— 被「生成结束自动快照」和「回滚接口」共用。

核心只有一个函数 snapshot_current_files：把某 session 当前 files 表里的全部文件，
完整复制成一个新版本（versions 一行 + version_files 一批），seq 单线递增。

这里是「在一个事务里写多张关联表」的典型场景，重点理解 flush 和 commit 的区别。
"""

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.file import File
from app.models.version import Version, VersionFile


async def snapshot_current_files(
    db: AsyncSession,
    session_id: str,
    summary: str | None = None,
) -> Version | None:
    """把 session 当前所有文件快照成一个新版本，返回新建的 Version；没文件则返回 None。

    seq 取该 session 现有最大 seq + 1（从 1 起），保证单线递增、不分叉。

    事务语义：版本行 + 它的所有文件行，要么一起成功、要么一起回滚，
    不会留下「建了版本却没存文件」的半拉子数据。这正是关系数据库事务的价值。
    """
    # 1. 读出当前所有文件。一条都没有就不建版本（比如纯聊天没写文件的那种轮次）
    result = await db.execute(select(File).where(File.session_id == session_id))
    files = result.scalars().all()
    if not files:
        return None

    # 2. 算下一个 seq = 当前最大 seq + 1。
    #    聚合函数 max 在「该 session 还没有任何版本」时返回 NULL → Python 侧是 None，
    #    用 (None or 0) 兜底成 0，+1 得到第一版 seq=1。
    result = await db.execute(
        select(func.max(Version.seq)).where(Version.session_id == session_id)
    )
    next_seq = (result.scalar_one() or 0) + 1

    # 3. 先建版本行，flush 把 INSERT 发到数据库、拿回自增主键 version.id，
    #    但事务尚未提交 —— 下一步的 version_files 需要这个 id 当外键。
    #    flush ≠ commit：flush 只是「把当前改动同步给数据库连接」，commit 才是「真正落盘、结束事务」。
    version = Version(session_id=session_id, seq=next_seq, summary=summary)
    db.add(version)
    await db.flush()

    # 4. 把每个文件复制进 version_files，外键指向刚建的版本。
    #    add_all 批量加入，比逐个 add 更省事。
    db.add_all([
        VersionFile(version_id=version.id, path=f.path, content=f.content)
        for f in files
    ])

    # 5. 一次 commit 把「版本 + 所有文件」作为一个事务整体落库。
    await db.commit()
    return version

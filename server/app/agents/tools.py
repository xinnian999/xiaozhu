"""Agent 工具集。

工具要操作"当前 session 的文件"，但 LLM 不该感知 session_id（那是后端会话身份，
不是业务参数）。所以这里用闭包把 db / session_id "封进去"，工具的 JSON Schema
里只暴露真正的业务参数（path / content）。每次请求重新构造一份工具实例，
因为它们绑定的是请求级别的 db。

注意：工具闭包里没法 yield SSE 事件，所以这些工具只负责「读写数据库 + 返回字符串」；
「写完后推 file_write / preview_refresh 给前端」这类事件，统一在 agent_loop 里
根据工具名做（见 app.agents.loop）。
"""

import asyncio
import json

from langchain_core.tools import tool
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app import log_store
from app.models.file import File


def build_tools(db: AsyncSession, session_id: str) -> list:
    """构造一组绑定到指定 session 的工具。"""

    @tool
    async def write_file(path: str, content: str) -> str:
        """写入或覆盖一个文件。path 是相对路径（如 src/App.tsx），content 是完整文件内容。"""
        # upsert：File 表对 (session_id, path) 有唯一约束，
        # 已存在则改 content，不存在则新建。
        result = await db.execute(
            select(File).where(File.session_id == session_id, File.path == path)
        )
        existing = result.scalar_one_or_none()
        if existing is not None:
            existing.content = content
        else:
            db.add(File(session_id=session_id, path=path, content=content))
        await db.commit()
        # 记下写入屏障：此刻之后浏览器产生的日志，才算这次写入引发的，
        # 供 get_browser_logs 判断「这次改动有没有跑出错」。
        log_store.mark_write(session_id)
        return f"已写入 {path}"

    @tool
    async def edit_file(path: str, old_string: str, new_string: str) -> str:
        """局部编辑已有文件：把文件里的 old_string 整段替换成 new_string。

        改已有文件时优先用它而不是 write_file —— 你只需输出「要改的那一小段」，
        不必重写整个文件，省 token、也快得多。
        要求：old_string 必须在文件中**唯一且完整**匹配（带上足够的上下文行来区分），
        否则无法确定改哪一处。新建文件请用 write_file。
        """
        result = await db.execute(
            select(File).where(File.session_id == session_id, File.path == path)
        )
        f = result.scalar_one_or_none()
        # 下面三种情况都不抛异常，而是返回说明性字符串 —— 它会作为 ToolMessage 回喂给
        # LLM，让模型自己读懂「为什么没改成」并纠正（比如改用 write_file、或补上下文）。
        if f is None:
            return f"文件 {path} 不存在，无法编辑。新建文件请用 write_file。"
        count = f.content.count(old_string)
        if count == 0:
            return (
                f"未找到要替换的内容：old_string 在 {path} 里不存在。"
                "请先用 read_file 读出原文，按原文逐字提供 old_string。"
            )
        if count > 1:
            return (
                f"old_string 在 {path} 里出现了 {count} 次，无法确定改哪一处。"
                "请在 old_string 里多带几行上下文，让它在文件中唯一。"
            )
        # 唯一命中：替换并存回完整内容。注意 str.replace 第三参数限定只替 1 次，
        # 双保险（前面已确认 count==1）。
        f.content = f.content.replace(old_string, new_string, 1)
        await db.commit()
        # 和 write_file 一样打写入屏障，供 get_browser_logs 判断这次改动有没有跑出错
        log_store.mark_write(session_id)
        return f"已编辑 {path}"

    @tool
    async def read_file(path: str) -> str:
        """读取文件内容。修改已有文件前必须先调此工具，否则会覆盖原有代码。"""
        result = await db.execute(
            select(File).where(File.session_id == session_id, File.path == path)
        )
        f = result.scalar_one_or_none()
        if f is None:
            # 不抛异常 —— 返回字符串让 LLM 自己处理「文件不存在」的语义
            return f"文件 {path} 不存在"
        return f.content

    @tool
    async def list_files() -> str:
        """列出当前项目下所有文件路径。开始生成前先调用，了解项目现有结构。"""
        # 只 select 一列，比把整个 File 行拉出来再 .path 省内存
        result = await db.execute(select(File.path).where(File.session_id == session_id))
        return json.dumps(result.scalars().all(), ensure_ascii=False)

    @tool
    async def get_browser_logs() -> str:
        """检查预览运行后的报错。写完文件后必须调用它，确认代码在浏览器里能正常跑。

        返回这次写入之后浏览器产生的 error / warning；没有就说明运行正常。
        """
        # 时序：写完文件后浏览器要经历「收到文件 → HMR → 重新编译 → 报错回传」，
        # 需要一点时间。这里轮询等「写入屏障之后的新日志」出现，最多等约 6 秒。
        #   - 错误早到了：第一轮就拿到，立即返回。
        #   - 错误还没到：每 0.25s 查一次，等它出现。
        #   - 代码没问题：前端不会推任何 error/warn，一直等到超时 → 返回「正常」。
        # 为什么是 6 秒而不是更短：功能多的大项目（多组件 + 重依赖）一次增量编译可能
        # 三四秒才报出错误，窗口太短会在错误回传前就超时返回「正常」，造成自检漏报。
        # 命中即返回，所以正常项目不会真的等满 6 秒，延长窗口只惠及「编译慢」的情况。
        for _ in range(24):  # 24 × 0.25s = 6s
            logs = log_store.logs_since_write(session_id)
            if logs:
                # 同一个编译错误往往被重复上报：dev server stdout 扫描、iframe 红屏
                # overlay、以及「揭晓后多拍 recheck」都会各打一遍。这里按 (level, text)
                # 去重再列出，避免相同报错刷很多行 —— 既省 AI 的阅读 token，也防止把
                # 后端那 50 条上限的缓冲挤爆、把别的真报错挤掉。
                seen: set[tuple[str, str]] = set()
                uniq = []
                for x in logs:
                    key = (x.level, x.text)
                    if key in seen:
                        continue
                    seen.add(key)
                    uniq.append(x)
                lines = "\n".join(f"[{x.level}] {x.text}" for x in uniq)
                return f"预览有以下报错/警告，请定位并修复：\n{lines}"
            await asyncio.sleep(0.25)
        return "预览运行正常，没有报错。"

    @tool
    async def update_preview() -> str:
        """把刚写的文件应用到预览，让它在浏览器里真正跑起来。

        重要：write_file 只是把文件「暂存」下来，并不会立刻刷新预览 —— 这样用户
        才不会看到「组件写好了、配套样式还没写」的半成品。等你写完一组完整、能正常
        渲染的改动后，调用本工具「揭晓」一次，预览才会更新。

        典型用法：write_file 写完所有相关文件 → update_preview → get_browser_logs 查报错。
        """
        # 这个工具本身不碰数据库，它只是一个「现在可以刷新预览了」的信号。
        # 真正的 SSE 推送在 agent_loop 里做（和 write_file 推 file_write 同理），
        # 因为 yield 事件得在生成器函数里，工具闭包里没法 yield。
        return "已请求刷新预览。"

    return [write_file, edit_file, read_file, list_files, get_browser_logs, update_preview]

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

from app import build_store, log_store
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
        # 供 check_build 判断「这次改动有没有跑出错」。
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
        # 和 write_file 一样打写入屏障，供 check_build 判断这次改动有没有跑出错
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
    async def check_build() -> str:
        """把刚写的改动应用到预览、构建一次，并返回构建/运行报错。

        写完一组完整、能渲染的改动后调用它：前端会把暂存文件同步进容器、跑一次
        `vite build`（也就是把这组改动「揭晓」给用户看），然后把构建结果回传回来。
        没有报错就说明构建通过、能正常跑。

        重要：write_file / edit_file 只是把文件「暂存」下来，并不会刷新预览 —— 这样
        用户才不会看到「组件写好了、配套样式还没写」的半成品。所以一组改动写完后，
        务必调一次 check_build 才会真正构建 + 揭晓，也才能拿到报错。

        典型用法：write_file 写完所有相关文件 → check_build → 有报错就修、再 check_build。
        """
        # 时序：本工具的 tool_call 一出现，agent_loop 就会先 build_store.arm() 架好会合点、
        # 再推 preview_refresh 信号给前端（工具闭包里没法 yield 事件，所以放在 loop 里做，
        # 见 app.agents.loop）。前端收到后同步文件 → vite build → 把「成没成」POST 回
        # /build-result，那个端点调 build_store.report 立旗唤醒下面这个 wait。

        # ① 等前端报回构建结果。前端多快 build 完、这里就多快返回，不再猜窗口。
        #    timeout=90 只是「前端彻底失联（构建卡死/断线）」的兜底，正常情况远用不到。
        result = await build_store.wait(session_id, timeout=90.0)
        if result is None:
            return "构建超时：预览迟迟没有回报结果，可能构建卡住或预览断开，请提示用户检查预览。"
        if not result.get("ok"):
            errors = str(result.get("errors") or "").strip() or "（无详细错误信息）"
            return f"预览构建失败（编译没通过），请定位并修复：\n{errors}"

        # ② 编译通过 ≠ 运行时没问题（如渲染时 undefined is not a function）。这类错误要等
        #    iframe 重载、应用真跑起来后才由浏览器 console 桥回传、落进 log_store。所以编译过
        #    之后再短暂扫一眼运行时报错：构建确定性的部分已拿到，这里只是尽力补一下运行时。
        for _ in range(12):  # 12 × 0.25s = 3s，只在编译通过时才花这点时间
            logs = log_store.logs_since_write(session_id)
            if logs:
                # 同一条报错可能连着刷好几条，按 (level, text) 去重再列出。
                seen: set[tuple[str, str]] = set()
                uniq = []
                for x in logs:
                    key = (x.level, x.text)
                    if key in seen:
                        continue
                    seen.add(key)
                    uniq.append(x)
                lines = "\n".join(f"[{x.level}] {x.text}" for x in uniq)
                return f"构建通过，但预览运行时报错，请定位并修复：\n{lines}"
            await asyncio.sleep(0.25)
        return "构建通过，预览正常，没有报错。"

    return [write_file, edit_file, read_file, list_files, check_build]

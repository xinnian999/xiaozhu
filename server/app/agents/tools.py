"""Agent 工具集。

工具要操作"当前 session 的文件"，但 LLM 不该感知 session_id（那是后端会话身份，
不是业务参数）。所以这里用闭包把 db / session_id "封进去"，工具的 JSON Schema
里只暴露真正的业务参数（path / content）。每次请求重新构造一份工具实例，
因为它们绑定的是请求级别的 db。

注意：工具闭包里没法 yield SSE 事件，所以这些工具只负责「读写数据库 + 返回字符串」；
「写完后推 file_write / preview_refresh 给前端」这类事件，统一在 agent_loop 里
根据工具名做（见 app.agents.loop）。

并发安全：一组工具共享同一个请求级 AsyncSession，而它**不允许被并发使用**。LangGraph
在后台任务里跑图：工具的 db 写入会和 agent_loop 消费端的落库（add_message / 写
tool_result）并发，撞同一个会话就报 "concurrent operations are not permitted" /
"transaction is closed"。所以由 agent_loop 建一把请求级 asyncio.Lock 传进来，**工具和
消费端共用同一把锁**，把所有碰 db 的操作串起来。check_build 不碰 db、且会长等（最多
90s）；ask_user 同理不碰 db，但等待方式不同——它用 LangGraph 的 interrupt() 把整个
调用暂停 + 图状态存进 checkpointer，直接结束这次请求，不占着一条长连接干等（详见
app.agents.loop 里 thread_id / checkpointer 的说明），所以这两个工具都不纳入 db_lock。
"""

import asyncio
import json

from langchain_core.tools import tool
from langgraph.types import interrupt
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app import build_store
from app.models.file import File


def build_tools(db: AsyncSession, session_id: str, db_lock: asyncio.Lock) -> list:
    """构造一组绑定到指定 session 的工具。

    db_lock：agent_loop 传入的请求级 asyncio.Lock，与消费端共用，串行化所有 db 操作。
    """

    @tool
    async def write_file(path: str, content: str) -> str:
        """写入或覆盖一个文件。path 是相对路径（如 src/App.tsx），content 是完整文件内容。"""
        # upsert：File 表对 (session_id, path) 有唯一约束，
        # 已存在则改 content，不存在则新建。
        async with db_lock:
            result = await db.execute(
                select(File).where(File.session_id == session_id, File.path == path)
            )
            existing = result.scalar_one_or_none()
            if existing is not None:
                existing.content = content
            else:
                db.add(File(session_id=session_id, path=path, content=content))
            await db.commit()
        return f"已写入 {path}"

    @tool
    async def edit_file(path: str, old_string: str, new_string: str) -> str:
        """局部编辑已有文件：把文件里的 old_string 整段替换成 new_string。

        改已有文件时优先用它而不是 write_file —— 你只需输出「要改的那一小段」，
        不必重写整个文件，省 token、也快得多。
        要求：old_string 必须在文件中**唯一且完整**匹配（带上足够的上下文行来区分），
        否则无法确定改哪一处。新建文件请用 write_file。
        """
        async with db_lock:
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
                    "请先用 read_files 读出原文，按原文逐字提供 old_string。"
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
        return f"已编辑 {path}"

    @tool
    async def read_files(paths: list[str]) -> str:
        """批量读取一个或多个文件的内容。修改已有文件前必须先用它读出原文，否则会覆盖原有代码。

        需要看多个文件时，把路径一次性都传进来，不要为每个文件分别调一次——工具调用之间
        隔着一次完整的模型往返，一个个读会白白多等好几轮；一次传够，一轮就能拿到全部内容。
        只看一个文件也用这个，传长度为 1 的列表即可。
        """
        async with db_lock:
            result = await db.execute(
                select(File.path, File.content).where(
                    File.session_id == session_id, File.path.in_(paths)
                )
            )
            found = dict(result.all())
        # 按传入顺序逐个拼结果，不存在的文件给出说明性文字而不是直接漏掉——
        # 让 LLM 知道「这个路径不对/还没建」，而不是误以为读取失败了。
        parts = [
            f"=== {path} ===\n{found[path] if path in found else f'文件 {path} 不存在'}"
            for path in paths
        ]
        return "\n\n".join(parts)

    @tool
    async def list_files() -> str:
        """列出当前项目下所有文件路径。开始生成前先调用，了解项目现有结构。"""
        # 只 select 一列，比把整个 File 行拉出来再 .path 省内存
        async with db_lock:
            result = await db.execute(select(File.path).where(File.session_id == session_id))
            paths = result.scalars().all()
        return json.dumps(paths, ensure_ascii=False)

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
        # 见 app.agents.loop）。前端收到后同步文件 → vite build → iframe 重载渲染、收集运行时
        # 报错 → 把「编译 + 运行」两类结果一并 POST 回 /build-result，那个端点调
        # build_store.report 立旗唤醒下面这个 wait。
        #
        # 所以这里只需纯等一个结果：前端多快回、这里多快返回，不靠固定窗口猜。
        # timeout=90 只是「前端彻底失联（构建卡死/断线）」的兜底，正常情况远用不到。
        result = await build_store.wait(session_id, timeout=90.0)
        if result is None:
            return "构建超时：预览迟迟没有回报结果，可能构建卡住或预览断开，请提示用户检查预览。"
        if result.get("ok"):
            return "构建通过，预览正常，没有报错。"
        errors = str(result.get("errors") or "").strip() or "（无详细错误信息）"
        if result.get("runtime"):
            # 编译过了、但 iframe 渲染时崩（如 undefined is not a function）
            return f"构建通过，但预览运行时报错，请定位并修复：\n{errors}"
        return f"预览构建失败（编译没通过），请定位并修复：\n{errors}"

    @tool
    async def ask_user(questions: list[dict]) -> str:
        """向用户提一批问题并等待回答，用于这一轮动手前把关键分歧问清楚，或动手过程中
        真正卡住时向用户求助。

        调用时机分两种：
        1) 这一轮【动手写代码前】（常规）：满足下面任一条件就该在第一次调用
           write_file/edit_file/check_build 之前，把这一轮想问的点一次性打包进本次
           调用问清楚，不要因为有好几个疑问就分多次调用：
           a) 存在会显著影响这一轮走向、且没有合理默认值的关键分歧（如整体风格该走
              极简还是国潮）；
           b) 这是从零搭建一个新应用/新页面，且请求比较笼统（如只说"写一个博客"），
              这种情况【即使核心方向已经清晰、能直接给出合理默认版本】，也该主动问
              一批「有更好、没有也不影响基础版本」的锦上添花选项（如评论区、标签
              分类、深色模式、多语言）——这条不是因为看不懂才问，是基础方案已经
              想好了、顺手多问一句能不能加分；对已有项目做局部小改动通常不用问这条。
        2) 这一轮【已经动手、但中途真正卡住】时（例外）：比如同一个报错反复修了 2 次
           以上仍过不了 check_build，或写的过程中发现一个会推翻当前方案走向的关键事实。
           这个窗口一整轮最多用一次，只能用于真正的阻塞，不能当成常规细节确认来用。
        这一轮一旦交付（check_build 通过、给出最终回复），就不要再调用，等用户发下一轮
        消息时再重新判断。

        questions 是一个列表，最多打包 5 个问题，每个元素形如
        {"question": "问题文案", "options": ["选项1", "选项2", ...], "multi": false}：
        - multi=false（单选，默认）：用于单一关键分歧（如整体风格该走极简还是国潮），
          options 需要 2~5 个具体互斥选项。
        - multi=true（多选）：用于一批彼此独立、可以自由勾选的偏好/功能项（如是否要
          评论区、标签分类、深色模式、国际化），options 需要 1~6 个独立选项，用户可以
          一个都不勾，这是合法结果。
        打包进同一次调用的问题应该彼此独立，不依赖作答顺序。前端会为每个问题额外提供
        一个自定义文字回答的入口，你不必关心这件事——只要正常处理返回的汇总文本即可，
        它可能是选项原文，也可能是用户自己写的话。

        调用会暂停当前这一轮，直到用户答完全部问题并提交，没有超时。
        """
        if not (1 <= len(questions) <= 5):
            return f"questions 必须是 1~5 个问题，当前 {len(questions)} 个，请修正后重新调用 ask_user。"
        problems: list[str] = []
        for i, q in enumerate(questions, start=1):
            options = q.get("options") or []
            multi = bool(q.get("multi", False))
            lo, hi = (1, 6) if multi else (2, 5)
            if not (lo <= len(options) <= hi):
                kind = "多选" if multi else "单选"
                problems.append(
                    f"第 {i} 题（{kind}）options 需要 {lo}~{hi} 个，当前 {len(options)} 个"
                )
        if problems:
            return "；".join(problems) + "。请修正后重新调用 ask_user。"
        # interrupt()：把图状态存进 checkpointer 后暂停，这次 astream() 调用到此结束
        # （HTTP 请求随之正常关闭）。resume 时从这里接着往下走，返回值就是
        # Command(resume=answer) 传入的 answer——见 app.agents.loop 的 __interrupt__
        # 处理分支 + app.api.ask_result 的恢复逻辑。注意：resume 会导致本工具函数
        # 从头重新执行一遍（LangGraph 的既定语义），上面的校验逻辑本身是幂等的纯校验，
        # 重跑一遍没问题。
        return interrupt({"questions": questions})

    return [write_file, edit_file, read_files, list_files, check_build, ask_user]

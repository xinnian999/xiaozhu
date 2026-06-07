"""Chat API —— agentic loop 版本。

不做 token 流，先跑通「LLM → 工具调用 → 执行 → 回传结果 → LLM 继续」这个循环。
流式体验后续再加，核心逻辑不变。
"""

import asyncio
import json
from collections.abc import AsyncGenerator

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.tools import tool
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app import log_store
from app.db import get_db
from app.deps import get_current_user
from app.models.user import User
# 模型注册表 + LLM 构造都集中在 app.llm，这里只是引用方
from app.llm import (
    ALLOWED_MODEL_IDS,
    DEFAULT_MODEL_ID,
    build_llm,
    public_models,
)
from app.models.file import File
# 起别名 DBMessage 避免和 langchain_core.messages 概念混淆
# （那边的 SystemMessage/HumanMessage 是 LLM 对话消息，这里的是数据库行）
from app.models.message import Message as DBMessage
from app.models.session import Session
from app.versioning import snapshot_current_files

router = APIRouter(prefix="/api", tags=["chat"])


SYSTEM_PROMPT = """你是 Vibuild，一个 AI 前端代码生成助手。
用户描述他们想要的应用，你负责生成 React 业务代码。

【项目骨架已就绪】
当前项目是一个已经配置好的 Vite + React + TypeScript 项目，以下文件已经存在，禁止修改：
- package.json / vite.config.ts / tsconfig.json / index.html / .npmrc

你只需要修改 src/ 下的业务代码：
- src/main.tsx 是入口（已存在，一般不需要改）
- src/App.tsx 是根组件（已存在，按用户需求改写）
- src/index.css 是全局样式（已存在，可改）
- 需要更多组件时，在 src/components/ 下新建

【样式】
- 项目已集成 Tailwind CSS，优先用 Tailwind 工具类（className="flex p-4 ..."）写样式
- src/index.css 已含 @tailwind 指令，一般不用动；只有定义全局/复杂样式时才改它
- 不要 import 额外 UI 库，用 Tailwind 工具类组合即可

【路由（按需，自行判断要不要用）】
项目已预装 react-router-dom@6.30.1（除 react/react-dom 外唯一额外可用的依赖）。
是否使用路由由你判断：
- 简单应用（单一视图、落地页、表单页等）：不要引入路由，直接在 src/App.tsx
  写一个组件即可，保持简单——别为了用而用。
- 多页面应用（有「首页 / 列表 / 详情 / 关于」等多个独立页面、需要靠地址切换）：
  才使用路由。

使用路由时，严格只用下面这套「组件式 API」（v6 的稳定写法）。
禁止使用 createBrowserRouter / RouterProvider / loader / action 那套 data router API
（版本间易变、容易写错）：
- 在 src/main.tsx 用 <BrowserRouter> 包裹 <App />
  （import { BrowserRouter } from 'react-router-dom'）
- 在 src/App.tsx 用 <Routes> + <Route path="..." element={<Xxx />} /> 定义路由
- 页面组件放 src/pages/ 下（如 src/pages/Home.tsx、src/pages/About.tsx）
- 导航用 <Link to="...">、<NavLink>；编程式跳转用 useNavigate()；取参数用 useParams()
- 共享布局用 <Outlet />；重定向用 <Navigate to="..." replace />
预览顶部的地址栏会显示当前路由、并支持前进 / 后退，路由配好就能用。

【写文件：新建用 write_file，改已有用 edit_file】
- 新建文件：write_file(path, content)，content 是完整文件内容。
- 修改已有文件：先 read_file 读出原文，再用 edit_file(path, old_string, new_string)
  只替换要改的那一小段。**不要**为了改几行就 write_file 把整个文件重写一遍 ——
  那样又慢又费 token。old_string 要按原文逐字复制、并带足够上下文行，保证在文件里唯一。

【工作流程】
1. 先调 list_files 看当前项目结构
2. 新建文件直接 write_file；改已有文件先 read_file，再用 edit_file 只改要动的部分
3. 一组完整、能正常渲染的改动都写完后，调 update_preview 把它们应用到预览
   （在此之前写的/改的文件只是暂存，预览不会刷新，用户看不到半成品）
4. 调 update_preview 之后，再调 get_browser_logs 检查预览有没有运行报错
5. 如果有报错：用 read_file 读出错文件 → 定位问题 → edit_file 修复对应片段 →
   update_preview → 再次 get_browser_logs 确认。最多修复 3 轮，仍修不好就如实告诉用户卡在哪
6. 确认无报错后，用一句话告诉用户做了什么

【自检要点】
- write_file / edit_file 只是暂存改动，必须调 update_preview 才会真正应用到预览并跑起来；
  顺序务必是「写完一组 → update_preview → get_browser_logs」，否则查到的是改动前的旧状态
- get_browser_logs 是你唯一能"看到"代码跑起来效果的方式，应用后务必调用
- 常见错误：变量名拼写、import 路径、JSX 语法、用了未安装的依赖
- 报错信息里通常带文件名和行号，照着定位

【禁止】
- 不要新增依赖（不要修改 package.json）；可直接 import 的依赖仅限已预装的
  react / react-dom / react-router-dom，用别的库一定会因为没装而报错
- 不要写 README、不要写测试文件
- 不要在 src 之外新建文件
"""


# ── 请求体 ──────────────────────────────────────────────────────────────────────

class ChatRequest(BaseModel):
    # session_id 改为必填：会话必须先通过 POST /api/sessions 创建。
    # Pydantic 缺字段时 FastAPI 自动返 422，不用我们手动校验。
    session_id: str
    message: str
    # 前端选的模型。可选 —— 不传就用白名单第一个（默认模型），
    # 这样老前端 / curl 不带 model 也能照常工作，向后兼容。
    # 注意：这里只接收字符串，「是否在白名单内」的校验放在路由层做（见 chat 函数），
    # 因为校验不通过要返回 HTTP 400，而 Pydantic 字段校验器不方便返回自定义 HTTP 状态码。
    model: str | None = None


# ── SSE 工具函数 ────────────────────────────────────────────────────────────────

def sse(event: dict) -> str:
    return f"data: {json.dumps(event, ensure_ascii=False)}\n\n"


def extract_text(response: AIMessage) -> str:
    """从 AIMessage 里取出纯文本内容。

    绑定工具后，content 可能是普通字符串，也可能是
    list[{"type": "text", "text": "..."}] 这样的 block 列表
    （模型边说话边调工具时常见），后者要把所有 text block 拼起来。
    """
    content = response.content
    if isinstance(content, str):
        return content
    return "".join(
        block.get("text", "") if isinstance(block, dict) else getattr(block, "text", "")
        for block in content
    )


# ── 工具工厂 ────────────────────────────────────────────────────────────────────
# 工具要操作"当前 session 的文件"，但 LLM 不该感知 session_id（那是后端会话身份，
# 不是业务参数）。所以这里用闭包把 db / session_id "封进去"，工具的 JSON Schema
# 里只暴露真正的业务参数（path / content）。每次请求重新构造一份工具实例，
# 因为它们绑定的是请求级别的 db。

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


# ── Agentic Loop ────────────────────────────────────────────────────────────────

async def agent_loop(req: ChatRequest, db: AsyncSession) -> AsyncGenerator[str, None]:
    """工具调用循环：LLM 决策 → 执行工具 → 回传结果 → LLM 继续，直到没有工具调用。"""
    # 每请求构造一次工具 + bind_tools，因为工具闭包了请求级别的 db / session_id
    tools = build_tools(db, req.session_id)
    tools_by_name = {t.name: t for t in tools}
    # 按本次请求选的模型现造 LLM 再 bind_tools。req.model 已在路由层校验过白名单，
    # 这里直接用。这是「每条消息可变模型」的落点：同一会话里这条用 qwen、
    # 下条用 claude 都行，因为每次进 agent_loop 都重新构造。
    llm = build_llm(req.model).bind_tools(tools)

    # 入库小助手：把一条消息写进 messages 表。闭包捕获 db / session_id，
    # 调用处只关心"存什么"。每存一条就 commit，保证自增 id 单调递增 ——
    # 回显时按 id 升序排，顺序就和当时直播看到的一模一样。
    async def save_message(
        role: str,
        text: str,
        *,
        kind: str = "text",
        tool_name: str | None = None,
        tool_args: dict | None = None,
    ) -> None:
        db.add(DBMessage(
            session_id=req.session_id,
            role=role,
            text=text,
            kind=kind,
            tool_name=tool_name,
            tool_args=tool_args,
        ))
        await db.commit()

    # 1. 先把用户消息入库 —— 即便 LLM 调用失败，用户消息也已经持久化，
    #    刷新后能看到自己发了什么
    await save_message("user", req.message)

    # 2. 加载历史对话作为上下文，让 LLM 记得之前聊过什么。
    #    只取 kind='text'（user 输入 + assistant 说过的话），把 kind='tool' 的
    #    工具行过滤掉 —— 工具的效果已经体现在 files 表的现状里，把工具调用重放给
    #    LLM 反而会让它误以为还要再调一次。kind 字段在这里第二次发挥作用。
    result = await db.execute(
        select(DBMessage)
        .where(DBMessage.session_id == req.session_id, DBMessage.kind == "text")
        .order_by(DBMessage.created_at.asc(), DBMessage.id.asc())
    )
    history = result.scalars().all()

    messages = [SystemMessage(content=SYSTEM_PROMPT)]
    for m in history:
        if m.role == "user":
            messages.append(HumanMessage(content=m.text))
        else:
            messages.append(AIMessage(content=m.text))

    # 累积本轮 assistant 的最终文本，用于结束时入库
    final_assistant_text = ""
    # 本轮是否真的写过文件 —— 只有写过才在结束时打一个版本快照，
    # 纯聊天 / 报错空转的轮次不该产生空版本。
    wrote_files = False

    # 硬性轮次上限：prompt 让 agent「最多修 3 轮」是软约束，模型未必听话。
    # 加一个兜底计数，防止「写错→检查→修错→再检查→……」无限烧 token。
    # 一次正常生成 + 几轮自检修复，25 轮足够；超了就强制收尾。
    MAX_TURNS = 25
    turns = 0

    try:
        while True:
            turns += 1
            if turns > MAX_TURNS:
                yield sse({
                    "type": "error",
                    "message": f"已达最大轮次（{MAX_TURNS}），自动停止以防死循环。",
                })
                break

            # astream：流式收取这一轮回复。它吐出一连串 AIMessageChunk（消息碎片），
            # 我们一边把新增文本实时推给前端（打字效果），一边用 `+` 把碎片累加回一个
            # 完整的 AIMessage —— AIMessageChunk 的 `+` 会自动拼接文本、聚合 tool_calls
            # 的碎片参数。累加完的 response 和原来 ainvoke 的结果等价，所以下面执行工具
            # 的逻辑一行都不用改。
            response: AIMessage | None = None
            async for chunk in llm.astream(messages):
                # 第一个碎片直接当起点，之后逐个累加
                response = chunk if response is None else response + chunk
                # 把「这个碎片」新增的文本增量实时推给前端。注意只推 chunk 自己的
                # 增量，不是累加后的全文，否则前端会收到越来越长的重复文本。
                delta = extract_text(chunk)
                if delta:
                    yield sse({"type": "message_delta", "text": delta})
            messages.append(response)  # 把拼好的完整回复追加进历史

            # content 和 tool_calls 是两个独立字段：模型可能只说话、只调工具，
            # 也可能「边说边调」。所以每一轮都先把文本取出来。
            text = extract_text(response)

            # finish_reason：模型为什么停。"stop"=正常说完，"tool_calls"=要调工具，
            # "length"=撞 max_tokens 被截断。截断时 write_file 的参数 JSON 是残缺的，
            # langchain 解析不出合法 tool_calls，会丢进 invalid_tool_calls。
            finish_reason = response.response_metadata.get("finish_reason")
            if response.invalid_tool_calls or finish_reason == "length":
                print(
                    f"[截断] finish_reason={finish_reason} "
                    f"invalid_tool_calls={response.invalid_tool_calls}"
                )
                yield sse({
                    "type": "error",
                    "message": "模型输出超长被截断，文件没写完。请把需求拆小，或分多次生成。",
                })
                break

            if not response.tool_calls:
                # 最终回复：文本已在上面的流式循环里逐字推过了，这里不再重复推，
                # 只记下来用于结束时入库（空字符串就不存）。
                if text:
                    final_assistant_text = text
                print(f"[最终回复] content={text}")
                break

            # 这一轮要调工具，但模型可能同时说了话（开场白 / 进度解释，
            # 如「好的，我先看看项目结构」）。这类过场叙述也是对话流的一部分：
            # 实时展示已经由流式循环完成，这里只负责入库（kind='text'），
            # 让刷新后能完整还原。
            if text:
                print(f"[response] content={text} (同轮调用了工具)")
                await save_message("assistant", text)

            # LLM 要调用一个或多个工具
            for tool_call in response.tool_calls:
                name = tool_call["name"]
                args = tool_call["args"]

                print(f"[tool_call] name={name} args={list(args.keys())}")

                # 推进度提示，让前端能显示"正在写入 App.tsx…"
                yield sse({"type": "tool_call", "name": name, "args": args})
                # 工具调用本身也存成一行消息（kind='tool'），回显时还原成工具卡
                await save_message("assistant", "", kind="tool", tool_name=name, tool_args=args)

                if name not in tools_by_name:
                    # 调了不存在的工具，告诉 LLM 并继续
                    messages.append(
                        ToolMessage(content=f"工具 {name} 不存在", tool_call_id=tool_call["id"])
                    )
                    continue

                tool_result = await tools_by_name[name].ainvoke(args)
                messages.append(
                    ToolMessage(content=str(tool_result), tool_call_id=tool_call["id"])
                )

                # get_browser_logs 的结果（报错详情 / "运行正常"）打到后端日志，方便排查。
                # 前端不展示，所以不推事件、也不入库。
                if name == "get_browser_logs":
                    print(f"[browser_logs] {tool_result}")

                # write_file 落库成功后，把整文件推给前端。注意：前端只用它更新
                # 代码视图 / 文件树，**不会**立刻同步进运行中的预览 —— 预览要等 AI 主动
                # 调 update_preview 才揭晓，避免把「组件写好、样式没跟上」的半成品闪给用户。
                if name == "write_file":
                    wrote_files = True
                    yield sse({
                        "type": "file_write",
                        "path": args["path"],
                        "content": args["content"],
                    })
                # edit_file 只改了局部，args 里没有完整内容（那正是省 token 的关键）。
                # 但前端要整文件 mount 进 WebContainer，所以这里把改完后的完整内容从库里
                # 读回来，再用同一个 file_write 事件推下去 —— 对前端来说和 write_file 没区别。
                # 只在「真的改成功」时才推：edit_file 成功返回 "已编辑 {path}"，失败（文件不
                # 存在 / 没匹配上 / 匹配多处）返回别的说明文字。用这个判定，避免给一次没改动的
                # 失败也推 file_write、还误打一个空版本快照。
                elif name == "edit_file" and tool_result == f"已编辑 {args['path']}":
                    res = await db.execute(
                        select(File.content).where(
                            File.session_id == req.session_id, File.path == args["path"]
                        )
                    )
                    content = res.scalar_one_or_none()
                    if content is not None:
                        wrote_files = True
                        yield sse({
                            "type": "file_write",
                            "path": args["path"],
                            "content": content,
                        })
                # AI 觉得「这一组改动写完、可以渲染了」时调 update_preview，
                # 这里推一个 preview_refresh 信号，前端收到才把暂存的文件同步进预览。
                elif name == "update_preview":
                    yield sse({"type": "preview_refresh"})

        # LLM 给出最终回复后，把 assistant 文本入库（空字符串就不存）
        if final_assistant_text:
            await save_message("assistant", final_assistant_text)

        # 本轮若改动过文件，把当前 files 全量快照成一个新版本（单线递增）。
        # summary 用这轮用户的需求当说明，列表 UI 里好认。
        if wrote_files:
            version = await snapshot_current_files(
                db, req.session_id, summary=req.message[:100]
            )
            # 推送版本事件，让前端在对话流里实时插入一张「版本卡」（带回滚按钮）。
            # 版本卡消息本身已由 snapshot_current_files 落库，刷新后也能回显。
            if version is not None:
                yield sse({"type": "version", "version_id": version.id, "seq": version.seq})

        yield sse({"type": "done"})

    except Exception as e:
        yield sse({"type": "error", "message": str(e)})
        yield sse({"type": "done"})


# ── 路由 ────────────────────────────────────────────────────────────────────────

@router.get("/models")
async def list_models() -> list[dict]:
    """返回可选模型清单，给前端渲染下拉框。

    具体只吐哪些字段、为什么不含 group/api_key，见 app.llm.public_models。
    """
    return public_models()


@router.post("/chat")
async def chat(
    req: ChatRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> StreamingResponse:
    """SSE 流式对话。"""

    # 模型校验 + 填默认值。放在路由层（而不是 Pydantic 字段里），是因为校验不通过
    # 要返回 HTTP 400，HTTPException 在这里写最自然。
    #   - 没传 model：用白名单第一个当默认，保证老前端 / curl 不带 model 也能跑。
    #   - 传了但不在白名单：拒绝。绝不把未经许可的 model 字符串透传给中转。
    if req.model is None:
        req.model = DEFAULT_MODEL_ID
    elif req.model not in ALLOWED_MODEL_IDS:
        raise HTTPException(status_code=400, detail=f"不支持的模型：{req.model}")

    # 先校验 session 存在「且属于当前用户」—— 否则后面工具一调用就报外键错，体验差，
    # 更重要的是防止拿别人的 session_id 往别人项目里写代码。
    # session_id 在请求体里（不在路径上），所以这里手动按 id + user_id 过滤，
    # 查不到统一 404（不泄露会话是否存在）。
    result = await db.execute(
        select(Session).where(
            Session.id == req.session_id,
            Session.user_id == current_user.id,
        )
    )
    if result.scalar_one_or_none() is None:
        raise HTTPException(status_code=404, detail="Session not found")

    # 注意：StreamingResponse 拿到的是生成器，FastAPI 会保持 db 依赖存活
    # 直到生成器耗尽（即整个 SSE 流结束），所以工具里使用 db 是安全的。
    return StreamingResponse(
        agent_loop(req, db),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )

"""Agentic Loop —— 改用 LangGraph 的图驱动。

循环本体（LLM 决策 → 执行工具 → 回传 → 继续）交给 langchain 的 create_agent 装配出
的 ReAct 图。本文件不再手写 while 循环,只负责三件事:
  1. 喂入:把历史对话装成 agent 的初始输入；
  2. 消费:遍历 agent.astream 的事件流,翻译成本项目的 SSE 协议；
  3. 落库:把消息、工具调用、版本快照写进库,并处理截断 / 超轮等异常。

输入契约 ChatRequest、两个 SSE 辅助函数也放这里。路由层(app.api.chat)只做鉴权 / 校验。
"""

import asyncio
import json
import re
from collections.abc import AsyncGenerator
from datetime import date

from fastapi import HTTPException
from langchain.agents import create_agent
from langchain_core.messages import AIMessage, HumanMessage
from langgraph.errors import GraphRecursionError
from pydantic import BaseModel
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app import build_store
from app.agents.prompts import SYSTEM_PROMPT
from app.agents.tools import build_tools
from app.llm import build_llm, models_by_id
from app.models.file import File
# 起别名 DBMessage 避免和 langchain_core.messages 概念混淆
# （那边的 SystemMessage/HumanMessage 是 LLM 对话消息,这里的是数据库行）
from app.models.message import Message as DBMessage
from app.models.user import User
from app.models.version import VersionFile
from app.templates import load_template
from app.versioning import snapshot_current_files


# ── 请求体 ──────────────────────────────────────────────────────────────────────

class ChatRequest(BaseModel):
    # session_id 改为必填:会话必须先通过 POST /api/sessions 创建。
    # Pydantic 缺字段时 FastAPI 自动返 422,不用我们手动校验。
    session_id: str
    message: str
    # 前端选的模型。可选 —— 不传就用白名单第一个（默认模型）,
    # 这样老前端 / curl 不带 model 也能照常工作,向后兼容。
    # 注意:这里只接收字符串,「是否在白名单内」的校验放在路由层做（见 chat 函数）,
    # 因为校验不通过要返回 HTTP 400,而 Pydantic 字段校验器不方便返回自定义 HTTP 状态码。
    model: str | None = None
    # 随本条消息附带的图片（多模态识图）。data URL 列表,缺省空列表 = 纯文本。
    # 「模型是否支持识图、张数 / 格式是否合法」的校验同样放路由层（见 chat 函数）。
    images: list[str] = []
    # 重试标记。为 True 时:不新存用户消息,而是复用「最新一轮的用户消息」当 prompt
    # 重新生成一遍,并把喂给 LLM 的历史截到那条消息为止 —— 丢掉它之后的旧回复,
    # 让模型重新作答而不是接着自己已答的内容往下说。重生成和普通一轮一样,
    # 结尾对「当前」文件态打一个新版本快照（单线递增、不删旧版本,所以是 v8 而不是改 v3）。
    # 此时 message / images 由前端留空,真正的 prompt 从库里捞最后一条用户消息。
    retry: bool = False


# ── SSE 工具函数 ────────────────────────────────────────────────────────────────

def sse(event: dict) -> str:
    return f"data: {json.dumps(event, ensure_ascii=False)}\n\n"


def extract_text(response) -> str:
    """从 AIMessage / AIMessageChunk 里取出纯文本内容。

    绑定工具后,content 可能是普通字符串,也可能是
    list[{"type": "text", "text": "..."}] 这样的 block 列表
    （模型边说话边调工具时常见）,后者要把所有 text block 拼起来。
    """
    content = response.content
    if isinstance(content, str):
        return content
    return "".join(
        block.get("text", "") if isinstance(block, dict) else getattr(block, "text", "")
        for block in content
    )


def build_human_content(text: str, images: list[str] | None) -> str | list[dict]:
    """把「文本 + 图片」拼成 LLM 的 HumanMessage content。

    没图片就直接返回纯字符串 —— 最省事、最省 token,行为和以前完全一样。
    有图片才用 OpenAI 风格的多模态 block 列表（中转站走 OpenAI 兼容协议,
    识图模型认这个格式）:
        [{"type": "text", "text": "..."},
         {"type": "image_url", "image_url": {"url": "data:image/png;base64,..."}}]
    data URL 可直接当 image_url.url 传,不用先上传换成 http 链接。
    """
    if not images:
        return text
    blocks: list[dict] = []
    if text:
        blocks.append({"type": "text", "text": text})
    blocks += [{"type": "image_url", "image_url": {"url": url}} for url in images]
    return blocks


# ── Agentic Loop（消费图的事件流）─────────────────────────────────────────────────

# 轮次上限:图用 recursion_limit(super-step 数)兜底死循环。call_model 与 tools
# 交替推进,一轮约 2 步,50 ≈ 原先手写的「25 轮 LLM 调用」。超限抛 GraphRecursionError。
RECURSION_LIMIT = 50

# 工具结果落库 / 下发前的截断上限。多数工具结果很短（"已写入 X"、报错列表），
# 但 read_file 会返回整文件，可能上万字 —— 截断防止把消息行和 SSE 帧撑爆。
TOOL_RESULT_CAP = 4000

# 从（可能还没写完的）工具参数 JSON 片段里抠出 path 值。
# 用途：write_file 的整个文件内容是作为 content 参数被逐 token 生成的，要等它全写完
# 工具调用才"完整"、卡片才发得出 —— 这就是"写完才看到卡片、还得等好久"的根源。
# path 排在参数 JSON 最前面，几个 token 就到，所以一旦正则匹配上 path，就能在内容还没
# 写完时把工具卡提前亮出来。((?:[^"\\]|\\.)*) 容忍路径里可能出现的转义字符。
_PATH_RE = re.compile(r'"path"\s*:\s*"((?:[^"\\]|\\.)*)"')


async def _charge_user(db: AsyncSession, user_id: str, model: str) -> None:
    """一轮「干净跑完」后按模型倍率扣点。只在成功路径调用（见 agent_loop 收尾）。

    扣费时机是「成功才扣」：报错 / 截断 / 用户中断都不会走到这里，所以没扣过、也无需返还。
    隔天重置就在这里发生：daily_date 不是今天 → 先把 daily_used 清零、再累加本轮 cost。

    自己吞掉异常：计费环节出问题也不该污染「已经成功」的 SSE 流——宁可这轮漏扣，
    也不要在 done 之前抛错、把一次成功的生成变成给用户看的报错。
    """
    try:
        cost = models_by_id()[model]["cost"]
        user = await db.get(User, user_id)
        if user is None:
            return
        today = date.today()
        if user.daily_date != today:
            user.daily_used = 0
            user.daily_date = today
        user.daily_used += cost
        await db.commit()
        print(f"[扣费] user={user_id} model={model} cost={cost} → daily_used={user.daily_used}")
    except Exception as e:
        print(f"[扣费失败] user={user_id} model={model}: {type(e).__name__}: {e}")


async def _prepare_retry(
    req: ChatRequest, db: AsyncSession
) -> tuple[DBMessage, list[dict]] | None:
    """重试前的准备:把「最新一轮」当作从没发生过,让 AI 能真正重新生成。

    为什么需要回退文件:重试若直接基于「当前文件」跑,AI 会看到需求其实已经实现了,
    于是什么都不改、也不产新版本 —— 表现就是"重试没反应"。所以必须先把文件回退到
    「这一轮开始前」的状态,AI 才会从头再写一遍。

    具体做四件事:
      1. 捞「最新一轮的用户消息」当本轮 prompt(回填到 req.message,供版本快照 summary 用);
      2. 把文件回退到这一轮开始前的状态 —— 即它的版本卡之前最近一张版本卡对应的快照;
         若它之前没有任何版本卡(这是第一轮),就回退到初始模板;
      3. 删掉这条用户消息之后的所有对话消息(旧回复 / 工具卡 / 版本卡),让对话看起来像
         把这条消息重新发了一遍。注意只删 messages,versions / version_files 快照一律不动,
         所以生成过的版本全部保留、仍能在「版本历史」里回滚;
      4. 算出「回退后该同步给前端的文件事件」并返回,调用方负责 yield 出去。

    返回 (最新一轮的用户消息, 文件同步事件列表);若一条用户消息都没有则返回 None。
    """
    # 1. 最新一轮的用户消息
    res = await db.execute(
        select(DBMessage)
        .where(
            DBMessage.session_id == req.session_id,
            DBMessage.role == "user",
            DBMessage.kind == "text",
        )
        .order_by(DBMessage.id.desc())
        .limit(1)
    )
    last_user = res.scalar_one_or_none()
    if last_user is None:
        return None
    req.message = last_user.text

    # 2a. 当前文件(= 旧的最后一轮结束后的状态),用来和回退目标做 diff,算出哪些要删
    res = await db.execute(select(File).where(File.session_id == req.session_id))
    old_contents = {f.path: f.content for f in res.scalars().all()}

    # 2b. 找「这一轮开始前」的版本:版本卡在 last_user 之前的最后一张。
    #     版本卡和版本快照一一对应(见 versioning.snapshot_current_files),
    #     从卡的 tool_args 里取 version_id 就能定位到要回退的那份快照。
    res = await db.execute(
        select(DBMessage)
        .where(
            DBMessage.session_id == req.session_id,
            DBMessage.kind == "version",
            DBMessage.id < last_user.id,
        )
        .order_by(DBMessage.id.desc())
        .limit(1)
    )
    prev_card = res.scalar_one_or_none()

    # 2c. 算出回退目标的文件状态 pre_round（path -> content）
    target_vid = prev_card.tool_args.get("version_id") if (prev_card and prev_card.tool_args) else None
    if target_vid is not None:
        res = await db.execute(
            select(VersionFile).where(VersionFile.version_id == target_vid)
        )
        pre_round = {vf.path: vf.content for vf in res.scalars().all()}
    else:
        # 它之前没有任何版本 = 这是第一轮,回到初始模板（和新建会话时预置的一致）
        pre_round = load_template("vite-react")

    # 3a. 用 pre_round 整体覆盖 files 表（删旧建新,和 versions.restore_version 同款写法）
    await db.execute(delete(File).where(File.session_id == req.session_id))
    db.add_all([
        File(session_id=req.session_id, path=path, content=content)
        for path, content in pre_round.items()
    ])

    # 3b. 删掉 last_user 之后的所有对话消息（versions/version_files 不动）
    await db.execute(
        delete(DBMessage).where(
            DBMessage.session_id == req.session_id,
            DBMessage.id > last_user.id,
        )
    )
    await db.commit()

    # 4. 算出回退后要同步给前端的文件事件：旧有新无的删、内容变了的重发。
    #    （这些事件由调用方在流里 yield；前端用现成的 file_write / file_delete 处理逻辑消费。）
    file_sync_events: list[dict] = []
    for path in old_contents:
        if path not in pre_round:
            file_sync_events.append({"type": "file_delete", "path": path})
    for path, content in pre_round.items():
        if old_contents.get(path) != content:
            file_sync_events.append({"type": "file_write", "path": path, "content": content})

    return last_user, file_sync_events


async def agent_loop(
    req: ChatRequest, db: AsyncSession, user_id: str
) -> AsyncGenerator[str, None]:
    """喂入历史 → 消费图的事件流 → 映射成 SSE + 落库副作用。

    user_id：本轮请求者。用于「成功才扣」——干净跑完时按模型倍率给他扣点（见收尾处）。
    """
    # 请求级 db 锁：本请求共享一个 AsyncSession，而它**不允许被并发使用**。
    # LangGraph 是在后台任务里跑图的 —— 图里工具的 db 写入，会和本消费端 add_message /
    # 落库 tool_result 的写入并发，撞上同一个会话就报 "concurrent operations are not
    # permitted" / "transaction is closed"。所以凡是碰这个 db 的地方（工具 + 这里的落库）
    # 都用这把锁串起来。锁只圈 db 调用本身、绝不跨 yield 持有（否则可能和图互相等待）。
    db_lock = asyncio.Lock()

    # 每请求构造工具(闭包 db / session_id),llm 按本请求选的模型构造。
    # create_agent 内部会 bind_tools、注入 system_prompt,所以这里不用自己绑、
    # messages 也不必塞 SystemMessage —— 这是「每条消息可变模型」的落点。
    #
    # 这一步可能失败,最常见的是 build_llm 发现「模型所属分组没在 .env 配 api_key」抛
    # HTTPException。关键在于:此处已经在 StreamingResponse 内部,HTTP 200 头早已发出 ——
    # 再往外抛异常,前端只会看到 SSE 流凭空中断,既收不到 error 也收不到 done,UI 永远
    # 卡在「思考中」。所以必须就地把异常翻译成 error + done 两帧,让前端正常收尾、把原因
    # 展示出来。HTTPException 用它的 detail(给用户的中文说明),其它异常退回 str(e)。
    try:
        llm = build_llm(req.model)
        tools = build_tools(db, req.session_id, db_lock)
        agent = create_agent(llm, tools, system_prompt=SYSTEM_PROMPT)
    except HTTPException as e:
        yield sse({"type": "error", "message": str(e.detail)})
        yield sse({"type": "done"})
        return
    except Exception as e:
        yield sse({"type": "error", "message": str(e)})
        yield sse({"type": "done"})
        return

    # 入库小助手:把一条消息写进 messages 表。闭包捕获 db / session_id,
    # 调用处只关心"存什么"。每存一条就 commit,保证自增 id 单调递增 ——
    # 回显时按 id 升序排,顺序就和当时直播看到的一模一样。
    async def save_message(
        role: str,
        text: str,
        *,
        kind: str = "text",
        tool_name: str | None = None,
        tool_args: dict | None = None,
        images: list[str] | None = None,
    ) -> DBMessage:
        # 返回刚存的 ORM 对象,方便调用方拿着它事后回填字段
        #（如工具结果要等执行完才有,见下面 check_build 落库）。
        msg = DBMessage(
            session_id=req.session_id,
            role=role,
            text=text,
            kind=kind,
            tool_name=tool_name,
            tool_args=tool_args,
            images=images,
        )
        async with db_lock:
            db.add(msg)
            await db.commit()
        return msg

    # 1. 准备本轮 prompt + 文件起点。分两条路:
    #    - 普通发送:把用户消息（连同图片）入库 —— 即便 LLM 调用失败,用户消息也已经
    #      持久化,刷新后能看到自己发了什么、发了哪几张图。空列表存成 None,保持纯文本干净。
    #    - 重试:见下面 _prepare_retry 的详细说明。它负责"把这一轮当作从没发生过":
    #      回退文件、删掉旧对话、并把回退后的文件状态同步给前端。
    if req.retry:
        prepared = await _prepare_retry(req, db)
        if prepared is None:
            # 一条用户消息都没有 —— 没什么可重试的,直接收尾
            yield sse({"type": "error", "message": "没有可重试的消息"})
            yield sse({"type": "done"})
            return
        # _prepare_retry 已回退好 files 表,并算好了「回退后该同步给前端的文件事件」:
        # 旧有新无的删掉、内容变了的重发,让代码视图 / 文件树 / 预览底子也回到这一轮开始前。
        _last_user, file_sync_events = prepared
        for ev in file_sync_events:
            yield sse(ev)
    else:
        await save_message("user", req.message, images=req.images or None)

    # 2. 加载历史对话作为图的初始 State。只取 kind='text'(user 输入 + assistant 说过
    #    的话),把 kind='tool' 的工具行过滤掉 —— 工具效果已体现在 files 表的现状里,
    #    把工具调用重放给 LLM 反而会让它以为还要再调一次。
    #    重试时上面已把旧回复删掉,这里自然就只剩到被重试消息为止的历史。
    result = await db.execute(
        select(DBMessage)
        .where(DBMessage.session_id == req.session_id, DBMessage.kind == "text")
        .order_by(DBMessage.created_at.asc(), DBMessage.id.asc())
    )
    history = result.scalars().all()

    # system prompt 已由 create_agent 注入(见上面构造处),这里只装对话历史。
    # 用户消息若带图片,用 build_human_content 拼成多模态 content 回放给 LLM ——
    # 这样不止当前这轮,过去几轮发过的图也会重新带上,模型能持续「看到」它们。
    # 代价是历史里的图每轮都重发,token 偏贵;练手项目图少,可接受(要省可改成只带最后一条)。
    messages = []
    for m in history:
        if m.role == "user":
            messages.append(HumanMessage(content=build_human_content(m.text, m.images)))
        else:
            messages.append(AIMessage(content=m.text))

    # 累积本轮 assistant 的最终文本,用于结束时入库
    final_assistant_text = ""
    # 本轮是否真的写过文件 —— 只有写过才在结束时打一个版本快照,
    # 纯聊天 / 报错空转的轮次不该产生空版本。
    wrote_files = False
    # 是否因截断提前收尾(截断时不再入库最终文本,但已写的文件仍要快照)。
    truncated = False
    # tool_call_id → (工具名, 参数, 入库的工具消息对象)。图把工具信息拆散到了两类事件里:
    #   - call_model 产出的 AIMessage 带 tool_calls(有名字 / 参数,没结果)
    #   - tools 节点产出的 ToolMessage 带结果 / tool_call_id(没名字 / 参数)
    # 所以这里在 call_model 阶段先把 (名字, 参数, 消息对象) 按 id 记下,等 tools 阶段拿
    # tool_call_id 回查,才能还原出「这是哪个工具、参数是什么、结果如何」,
    # 并把结果回填到那条工具消息上(见 check_build 落库)。
    pending: dict[str, tuple[str, dict, DBMessage]] = {}

    # ── 工具卡「流式提前亮」用的累积状态 ──
    # 目的：在 messages 模式里盯 tool_call_chunks（参数碎片逐 token 流过来），一旦解析出 path
    # 就提前 yield 一张工具卡，不必等整段 content 写完。下面四个量配合完成"碎片→提前卡片"：
    announced_tools: set[str] = set()      # 已发过卡片的 tool_call id —— updates 阶段据此不再重发，避免双卡
    path_sent: set[str] = set()            # 已补过 path 那一帧的 tool_call id（避免重复补）
    tool_chunk_args: dict[str, str] = {}   # tool_call id -> 已累积的参数 JSON 片段（用来匹配 path）
    tool_chunk_idx: dict[int, str] = {}    # 流式碎片的 index -> tool_call id（续传碎片不带 id，只能靠 index 关联）
    tool_chunk_name: dict[str, str] = {}   # tool_call id -> 工具名（只有每个调用的第一个碎片带名字，先记下备用）

    try:
        # 同时开 updates(节点边界,做副作用)+ messages(token 流,做打字效果)。
        async for mode, chunk in agent.astream(
            {"messages": messages},
            stream_mode=["updates", "messages"],
            config={"recursion_limit": RECURSION_LIMIT},
        ):
            # ── messages 模式:LLM 的 token 增量 ──
            if mode == "messages":
                msg, meta = chunk
                # 只推 model 节点的 token(对话打字效果);tools 节点也会在这个模式里
                # 吐 ToolMessage 内容,那是工具结果、不是对话,必须按节点名过滤掉。
                # 注意:create_agent 的 LLM 节点名是 "model"(手搓时叫 "call_model")。
                if meta.get("langgraph_node") == "model":
                    delta = extract_text(msg)
                    if delta:
                        yield sse({"type": "message_delta", "text": delta})

                    # 工具调用的参数也是逐 token 流过来的（tool_call_chunks）：每个调用的第一个
                    # 碎片带 name+id，后续"续传碎片"只有一段 args 文本、不带 id —— 只能靠 index
                    # 关联回同一个调用。
                    #
                    # 卡片要「秒出」：一旦拿到工具名（第一个碎片就带）就立刻发一张空参卡，让前端先
                    # 显示卡片 + 转圈，不必等参数写完。原先靠正则等 path 才发卡，但模型并不保证
                    # 按 schema 顺序吐参数（实测 write_file 会先吐一大段 content、最后才吐 path），
                    # 那样卡片要等整个文件写完才出，等于没有提前。改成「见名出卡」就稳了。
                    # path 流到了再补一帧（让卡片标题从「写入」变成「写入 src/App.tsx」）。
                    for tcc in getattr(msg, "tool_call_chunks", None) or []:
                        idx = tcc.get("index") or 0
                        cid = tcc.get("id")
                        if cid:
                            # 第一个碎片：登记 id / 名字，并以本段 args 作为累积起点
                            tool_chunk_idx[idx] = cid
                            tool_chunk_args[cid] = tcc.get("args") or ""
                            tool_chunk_name[cid] = tcc.get("name") or ""
                        else:
                            # 续传碎片：按 index 找回它属于哪个调用，接着往后拼参数
                            cid = tool_chunk_idx.get(idx)
                            if cid is not None:
                                tool_chunk_args[cid] += tcc.get("args") or ""
                        if not cid:
                            continue
                        name = tool_chunk_name.get(cid, "")
                        # ① 见名出卡：拿到工具名且没发过 → 立刻发一张空参卡（卡片+转圈秒出）
                        if name and cid not in announced_tools:
                            announced_tools.add(cid)
                            print(f"[tool_call·流式提前·出卡] name={name}")
                            yield sse({"type": "tool_call", "name": name, "args": {}, "id": cid})
                        # ② path 补帧：参数里一旦能解析出 path 且还没补过 → 再发一帧带 path 的，
                        #    让卡片标题补上文件名。content 不在这里发（前端工具卡本就不展示文件内容）。
                        if cid in announced_tools and cid not in path_sent:
                            mt = _PATH_RE.search(tool_chunk_args.get(cid, ""))
                            if mt:
                                path_sent.add(cid)
                                yield sse({
                                    "type": "tool_call",
                                    "name": name,
                                    "args": {"path": mt.group(1)},
                                    "id": cid,
                                })
                continue

            # ── updates 模式:chunk = {节点名: 该节点 return 的 update} ──
            for node_name, update in chunk.items():
                node_messages = update.get("messages", []) if isinstance(update, dict) else []

                if node_name == "model":
                    # model 节点只 return 一条消息,但写成循环更稳妥
                    for m in node_messages:
                        # 截断检测:撞 max_tokens(finish_reason="length")或参数 JSON 残缺
                        #(langchain 解析不出合法 tool_calls,丢进 invalid_tool_calls)。
                        finish_reason = m.response_metadata.get("finish_reason")
                        if m.invalid_tool_calls or finish_reason == "length":
                            print(
                                f"[截断] finish_reason={finish_reason} "
                                f"invalid_tool_calls={m.invalid_tool_calls}"
                            )
                            yield sse({
                                "type": "error",
                                "message": "模型输出超长被截断,文件没写完。请把需求拆小,或分多次生成。",
                            })
                            truncated = True
                            break

                        text = extract_text(m)
                        if m.tool_calls:
                            # 边说边调的过场文本(如「好的,我先看看项目结构」):已通过
                            # message_delta 实时推过,这里只入库(kind='text')供刷新还原。
                            if text:
                                print(f"[response] content={text} (同轮调用了工具)")
                                await save_message("assistant", text)
                            # 推进度提示 + 工具行入库 + 记下 (名字, 参数) 待回查
                            for tc in m.tool_calls:
                                print(f"[tool_call] name={tc['name']} args={list(tc['args'].keys())}")
                                # 这里总是再发一次「完整参数」的 tool_call。前端 tool_call 是按 id 幂等的
                                # （upsertToolCall）：流式阶段提前发的卡只带 path，到这一步用完整参数（含
                                # write_file 的 content）把同一张卡补全，展开就能看到全部参数。没提前发过的
                                #（无 path 的 list_files / check_build）则由这一发直接新建卡。
                                yield sse({"type": "tool_call", "name": tc["name"], "args": tc["args"], "id": tc["id"]})
                                # check_build 的 tool_call 一出现就推构建信号：让前端先开始
                                # 同步文件 + vite build。这一步必须趁早（在下面 tools 节点真正
                                # 执行 check_build 之前）—— 因为工具闭包里没法 yield 事件。
                                if tc["name"] == "check_build":
                                    # 先 arm 架好会合点、再发信号：保证前端 build 完 POST 回结果
                                    # 时，build_store 里一定已有等它的 Event（先架接收器再触发）。
                                    build_store.arm(req.session_id)
                                    yield sse({"type": "preview_refresh"})
                                tool_msg = await save_message(
                                    "assistant", "", kind="tool",
                                    tool_name=tc["name"], tool_args=tc["args"],
                                )
                                pending[tc["id"]] = (tc["name"], tc["args"], tool_msg)
                        else:
                            # 没有 tool_calls = 最终回复。文本已逐字推过,这里只记下来,
                            # 循环结束后入库(空字符串就不存)。
                            if text:
                                final_assistant_text = text
                            print(f"[最终回复] content={text}")
                    if truncated:
                        break

                elif node_name == "tools":
                    # 工具已执行完,按 tool_call_id 回查是哪个工具,映射对应副作用
                    for tm in node_messages:
                        name, args, tool_msg = pending.get(tm.tool_call_id, (None, None, None))
                        if name is None:
                            continue
                        tool_result = str(tm.content or "")

                        # 所有工具的结果统一「落库 + 下发」:
                        #   落库:写进这条工具消息的 text(截断防超长),刷新后还能在工具卡里看到;
                        #   下发:推 tool_result 事件,前端按 tool_call_id 找到对应工具卡、实时填上结果。
                        # 历史回放只取 kind='text' 的消息,工具消息(kind='tool')被过滤,所以这些结果
                        # 不会被重放给 LLM;前端工具卡原本不渲染 text,改用 tool_result 字段单独展示。
                        capped = (
                            tool_result
                            if len(tool_result) <= TOOL_RESULT_CAP
                            else tool_result[:TOOL_RESULT_CAP] + "\n…（结果过长已截断）"
                        )
                        tool_msg.text = capped
                        async with db_lock:
                            await db.commit()
                        yield sse({"type": "tool_result", "id": tm.tool_call_id, "result": capped})

                        # ── 各工具特有的副作用 ──
                        # check_build:构建信号已在上面 tool_call 阶段推过(preview_refresh),
                        # 结果也已落库 / 下发,这里只补一行后端日志便于实时观察。
                        if name == "check_build":
                            print(f"[check_build] {tool_result}")

                        # write_file 落库成功后,把整文件推给前端更新代码视图 / 文件树
                        #（预览不会立刻同步,要等 AI 调 check_build 才揭晓 + 构建）
                        elif name == "write_file":
                            wrote_files = True
                            yield sse({
                                "type": "file_write",
                                "path": args["path"],
                                "content": args["content"],
                            })
                        # edit_file 的 args 里没有完整内容(那正是省 token 的关键),
                        # 但前端要整文件 mount,所以改成功后从库里回读完整内容再推。
                        # 只在「真改成功」时推:成功返回 "已编辑 {path}",失败返回别的说明文字。
                        elif name == "edit_file" and tool_result == f"已编辑 {args['path']}":
                            async with db_lock:
                                res = await db.execute(
                                    select(File.content).where(
                                        File.session_id == req.session_id,
                                        File.path == args["path"],
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

            if truncated:
                break

        # ── 收尾(正常结束 / 截断 break 都会走到这里)──
        # 最终回复入库(截断时 final_assistant_text 为空,不入库)
        if final_assistant_text:
            await save_message("assistant", final_assistant_text)

        # 本轮若改动过文件,把当前 files 全量快照成一个新版本(单线递增)。
        # 截断但已写过部分文件时也快照,和原先手写循环的行为保持一致。
        if wrote_files:
            version = await snapshot_current_files(
                db, req.session_id, summary=req.message[:100]
            )
            # 推送版本事件,前端在对话流里实时插入一张「版本卡」(带回滚按钮)。
            if version is not None:
                yield sse({"type": "version", "version_id": version.id, "seq": version.seq})

        # 「成功才扣」：走到这里且没被截断 = 这一轮干净跑完，按模型倍率扣点。
        # 截断（truncated）虽然也流到这条收尾，但属于失败，用 not truncated 挡掉、不扣。
        # 报错 / 用户中断更不会到这里（在 except 分支或 yield 处就被打断了）。
        if not truncated:
            await _charge_user(db, user_id, req.model)

        yield sse({"type": "done"})

    except GraphRecursionError:
        # 撞到 recursion_limit:等价于原先「超过 MAX_TURNS」的兜底。
        yield sse({
            "type": "error",
            "message": "已达最大轮次,自动停止以防死循环。",
        })
        yield sse({"type": "done"})
    except Exception as e:
        yield sse({"type": "error", "message": str(e)})
        yield sse({"type": "done"})

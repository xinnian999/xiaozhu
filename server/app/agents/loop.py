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
from app.agents.middleware import NoBluffMiddleware
from app.agents.prompts import SYSTEM_PROMPT
from app.agents.tools import build_tools
from app.checkpointer import get_checkpointer
from app.llm import build_llm, models_by_id
from app.model_providers import reasoning_observation, split_inline_thinking
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


# check_build 最多等 90s，生产环境的反代（Caddy）如果配了较短的 idle/read timeout，
# 可能会把这条长时间「有连接但没数据」的 SSE 中途掐断。/api/chat 和 /ask-result（resume）
# 都可能触发 check_build 这段长等待，所以两边共用这一层心跳包装。
#
# 只在长时间没有新事件时插入一帧 SSE 注释当心跳，保活连接；前端解析器本就按
# 「不以 data: 开头就丢弃」处理，纯心跳、零业务影响。
async def with_heartbeat(
    gen: AsyncGenerator[str, None], interval: float = 20.0
) -> AsyncGenerator[str, None]:
    it = gen.__aiter__()
    next_task = asyncio.ensure_future(it.__anext__())
    try:
        while True:
            done, _ = await asyncio.wait({next_task}, timeout=interval)
            if not done:
                yield ": ping\n\n"
                continue
            try:
                item = next_task.result()
            except StopAsyncIteration:
                return
            yield item
            next_task = asyncio.ensure_future(it.__anext__())
    finally:
        next_task.cancel()


def extract_text(response) -> str:
    """从 AIMessage / AIMessageChunk 里取出纯文本内容。

    绑定工具后,content 可能是普通字符串,也可能是
    list[{"type": "text", "text": "..."}] 这样的 block 列表
    （模型边说话边调工具时常见）,后者要把所有 text block 拼起来。
    """
    content = response.content
    if isinstance(content, str):
        return split_inline_thinking(content)[0]
    parts: list[str] = []
    for block in content:
        if isinstance(block, dict):
            if str(block.get("type", "")).lower() in {
                "thinking",
                "reasoning",
                "reasoning_content",
            }:
                continue
            text = block.get("text", "")
        else:
            text = getattr(block, "text", "")
        if text:
            parts.append(split_inline_thinking(str(text))[0])
    return "".join(parts)


def _is_truncation_reason(reason: object) -> bool:
    """兼容 OpenAI、Anthropic 与 Google 的输出上限结束标记。"""
    normalized = str(reason).strip().lower().replace("-", "_")
    return normalized in {
        "length",
        "max_tokens",
        "max_output_tokens",
    } or normalized.endswith(".max_tokens")


def build_human_content(text: str, images: list[str] | None) -> str | list[dict]:
    """把「文本 + 图片」拼成 LLM 的 HumanMessage content。

    没图片就直接返回纯字符串 —— 最省事、最省 token,行为和以前完全一样。
    有图片时使用 LangChain 标准内容块，由各厂商适配器转换成自己的 wire format。
    这样 Anthropic / Gemini 不会再收到硬编码的 OpenAI ``image_url`` 结构。
    """
    if not images:
        return text
    blocks: list[dict] = []
    if text:
        blocks.append({"type": "text", "text": text})
    for url in images:
        if url.startswith("data:") and ";base64," in url:
            header, data = url.split(",", 1)
            mime_type = header[5:].split(";", 1)[0] or "image/png"
            blocks.append({"type": "image", "base64": data, "mime_type": mime_type})
        else:
            blocks.append({"type": "image", "url": url})
    return blocks


# ── Agentic Loop（消费图的事件流）─────────────────────────────────────────────────

# 轮次上限:图用 recursion_limit(super-step 数)兜底死循环。call_model 与 tools
# 交替推进本来一轮约 2 步；接入 NoBluffMiddleware 后它的 after_model 钩子会在图里
# 多插一个节点（model → NoBluffMiddleware.after_model → tools），一轮变成约 3 步，
# 75 ≈ 原先手写的「25 轮 LLM 调用」（50 是没接中间件时的旧值，接入后同样的 25 轮
# 预算会被提前耗尽，导致改动没做完就被当成死循环打断）。超限抛 GraphRecursionError。
RECURSION_LIMIT = 75

# 工具结果落库 / 下发前的截断上限。多数工具结果很短（"已写入 X"、报错列表），
# 但 read_file 会返回整文件，可能上万字 —— 截断防止把消息行和 SSE 帧撑爆。
TOOL_RESULT_CAP = 4000

# 单个思考卡最多持久化 / 下发的字符数。保留完整可读过程的同时，避免极端模型
# 把数万字隐藏推理塞进一条 messages 记录和 SSE 帧。
REASONING_CONTENT_CAP = 20_000


def _reasoning_payload(response: object) -> dict:
    """把任意厂商响应归一成前端可直接渲染的思考事件。"""
    observation = reasoning_observation(response)
    content = observation.content.strip()
    truncated = len(content) > REASONING_CONTENT_CAP
    if truncated:
        content = content[:REASONING_CONTENT_CAP] + "\n\n…（思考过程过长，已截断）"

    fallback = not content
    if fallback and observation.tokens:
        content = "模型已完成思考，但当前接口只返回推理 token 数，没有返回可展示的思考过程。"
    elif fallback:
        content = "当前模型或接口没有返回可展示的思考过程。"

    return {
        "type": "reasoning",
        "text": content,
        "tokens": observation.tokens or None,
        "fallback": fallback,
        "truncated": truncated,
    }

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


async def _save_message(
    db: AsyncSession,
    db_lock: asyncio.Lock,
    session_id: str,
    role: str,
    text: str,
    *,
    kind: str = "text",
    tool_name: str | None = None,
    tool_args: dict | None = None,
    images: list[str] | None = None,
) -> DBMessage:
    """把一条消息写进 messages 表,返回刚存的 ORM 对象。

    独立成模块级函数(不再是 agent_loop 内的闭包)是因为 _consume 要同时给
    agent_loop(发新消息)和 ask_result 的 resume 端点共用,不能再靠闭包捕获 db_lock /
    session_id —— 两边都显式传进来。
    """
    msg = DBMessage(
        session_id=session_id,
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


async def _save_reasoning_message(
    db: AsyncSession,
    db_lock: asyncio.Lock,
    session_id: str,
    payload: dict,
) -> DBMessage:
    """持久化思考卡；正文与展示元数据分开存，刷新后可无损还原。"""
    return await _save_message(
        db,
        db_lock,
        session_id,
        "assistant",
        str(payload["text"]),
        kind="reasoning",
        tool_args={
            "tokens": payload.get("tokens"),
            "fallback": bool(payload.get("fallback")),
            "truncated": bool(payload.get("truncated")),
        },
    )


async def _early_file_write(
    db: AsyncSession, db_lock: asyncio.Lock, session_id: str, tc: dict
) -> dict | None:
    """把一个「写文件类」tool_call 提前折算成 file_write 事件（供竞态防护抢发）。

    背景：模型可能无视 parallel_tool_calls，把若干 write_file/edit_file 和 check_build
    塞进同一批 tool_calls。LangGraph 的 tools 节点是**屏障**——它那一批的 ToolMessage
    要等批内所有工具（含会阻塞最长 90s 的 check_build）都跑完才一次性产出。也就是说，
    真正携带文件内容的 file_write 事件（在 tools 节点分支里发，见 _consume）会被 check_build
    死死拖在后面；而 check_build 的 arm+preview_refresh 却在 model 节点就发了出去 ——
    于是前端「先收到 preview_refresh 去构建、后才收到 file_write」，构建到的是改动前的旧
    文件，误报「构建通过」。

    对策：一旦发现某批 tool_calls 里带 check_build，就在 arm+preview_refresh 之前，用各写
    文件工具**自己的 args** 把 file_write 抢先折算出来发给前端，确保预览构建到的是这一批的
    新内容。返回可直接 yield 的事件 dict；拿不到可靠内容（参数缺失 / edit 命中不唯一）时返回
    None，那一个文件退回 tools 节点的原路径（这类「批量 + edit + check_build 同现」本就罕见）。

    仅在「同批含 check_build」时才调用。正常分轮调用（先 write 再单独 check_build）走不到
    这里，行为完全不变，也不会有重复的 file_write。
    """
    name = tc.get("name")
    args = tc.get("args") or {}
    if name == "write_file":
        # write_file 的完整内容就在 args 里，直接用，最可靠。
        path, content = args.get("path"), args.get("content")
        if isinstance(path, str) and isinstance(content, str):
            return {"type": "file_write", "path": path, "content": content}
        return None
    if name == "edit_file":
        # edit_file 只给了 old/new 片段，得读当前库内容算出替换后的结果。
        path, old, new = args.get("path"), args.get("old_string"), args.get("new_string")
        if not (isinstance(path, str) and isinstance(old, str) and isinstance(new, str)):
            return None
        async with db_lock:
            res = await db.execute(
                select(File.content).where(
                    File.session_id == session_id, File.path == path
                )
            )
            content = res.scalar_one_or_none()
        # 只有唯一命中才敢提前折算，和 edit_file 工具本身同款守卫；含糊 / 找不到就不抢发。
        if content is None or content.count(old) != 1:
            return None
        return {"type": "file_write", "path": path, "content": content.replace(old, new, 1)}
    return None


async def _cleanup_thread(thread_id: str) -> None:
    """一轮真正跑完(没有 pending interrupt)后清掉这次的 checkpoint。

    messages 表才是历史的唯一真相源,checkpointer 只是"这一轮进行中"的临时状态
    (见 app.checkpointer 顶部说明)——不清理的话 checkpoint 库会无限增长。

    自己吞掉异常,理由同 _charge_user:清理失败不该污染已经成功 / 已经报错收尾的 SSE 流。
    """
    try:
        await get_checkpointer().adelete_thread(thread_id)
    except Exception as e:
        print(f"[checkpoint 清理失败] thread_id={thread_id}: {type(e).__name__}: {e}")


async def _file_tree_note(db: AsyncSession, session_id: str) -> str:
    """现查 files 表拼出当前项目文件树，作为 system prompt 的动态附加段。

    files 表才是文件现状的唯一真相源，但从没喂给过 LLM——模型每轮/每次 ask_user
    恢复后都只能靠 list_files/read_files 盲探，哪怕是刚写过的文件也要重新问一遍
    才知道存在（kind='tool' 的历史行不重放，见 agent_loop 里加载历史那段注释）。
    只给路径不给内容：内容仍按需用 read_files 批量取，避免项目变大后每次都要把
    全部文件内容重发一遍。调用方（agent_loop / ask_result 的 resume）都要在自己
    那次真正的文件状态确定之后才查这个，保证拿到的是当下的准确状态。
    """
    result = await db.execute(select(File.path).where(File.session_id == session_id))
    file_paths = sorted(result.scalars().all())
    return (
        "\n\n【当前项目文件】(以下路径在 files 表里真实存在,无需 list_files 确认;"
        "要看某个文件具体写了什么用 read_files 批量读取)\n"
        + ("\n".join(f"- {p}" for p in file_paths) if file_paths else "(项目为空,还没有任何文件)")
    )


# ── resume / ask_result 共用的重建 helper ─────────────────────────────────────
# ask_user 的 resume（app.api.ask_result）和「生成中断后续跑」（app.api.resume）都要
# 干同一件事：用同一个 thread_id 重新把 llm/tools/agent 装回来（checkpointer 只持久化
# 图状态，不持久化这些运行时对象），再从检查点接着跑。这三个 helper 把这套重复逻辑收口，
# 两个路由共用，避免各写一份、日后改 create_agent 参数还要改多处。

async def latest_round_thread_id(db: AsyncSession, session_id: str) -> str | None:
    """算出「最新一轮」的 thread_id：取该 session 最后一条 role='user' kind='text' 消息 id。

    thread_id 与「这一轮」绑定（见 agent_loop 里的说明），触发本轮的用户消息 id 是它的
    确定性来源——刷新页面后 JS 上下文没了也能靠它重算，进而找回检查点。
    一条用户消息都没有 → None（没有可恢复/续跑的轮次）。
    """
    result = await db.execute(
        select(DBMessage)
        .where(
            DBMessage.session_id == session_id,
            DBMessage.role == "user",
            DBMessage.kind == "text",
        )
        .order_by(DBMessage.id.desc())
        .limit(1)
    )
    last_user = result.scalar_one_or_none()
    return f"{session_id}:{last_user.id}" if last_user is not None else None


def build_round_agent(db: AsyncSession, session_id: str, model: str, db_lock: asyncio.Lock, tree_note: str):
    """按本轮选的模型重建 llm/tools/agent（含 checkpointer + NoBluffMiddleware）。

    与 agent_loop 首次创建 agent 的装配方式完全一致，供 resume / ask_result 复用。
    调用方负责先算好 tree_note（当下真实文件状态）和 db_lock。
    """
    llm = build_llm(model)
    tools = build_tools(db, session_id, db_lock)
    agent = create_agent(
        llm,
        tools,
        system_prompt=SYSTEM_PROMPT + tree_note,
        checkpointer=get_checkpointer(),
        middleware=[NoBluffMiddleware(llm)],
    )
    return agent


async def reseed_pending_from_state(
    db: AsyncSession, session_id: str, state
) -> dict[str, tuple[str, dict, DBMessage]]:
    """从检查点图状态里找出「还没有 ToolMessage 回填」的 tool_calls，补种 pending 字典。

    resume / 续跑都是一次全新的 astream() 调用：那些 tool_call 是在【上一次】被打断的调用
    里产出的，这次不会重新产出对应的 "model" 节点事件，pending 天然是空的。不补种的话，
    续跑后 "tools" 节点回传的 ToolMessage 会因按 tool_call_id 查不到而被静默丢弃（结果存不
    进 DB、前端也收不到 tool_result）。见 _consume 的 initial_pending 参数说明。

    做法：扫描 state.values["messages"]，收集所有已出现的 ToolMessage.tool_call_id（=已完成），
    再遍历 AIMessage.tool_calls，把「尚未完成」的那些，逐个匹配 DB 里对应的待回填工具行
    （kind='tool' 且 text=''，按 tool_name + tool_args 精确匹配），拼成 {id: (name, args, DBMessage)}。

    这是 ask_result 里单个 ask_user 补种逻辑的推广——覆盖「断连时正卡在 tools 节点
    （check_build / write_file 尚未回传结果）」这一续跑最常见场景。
    """
    messages = state.values.get("messages", []) if state and state.values else []

    # 已有 ToolMessage 的 tool_call_id = 该工具已执行完，不用补种
    done_ids: set[str] = set()
    for m in messages:
        tcid = getattr(m, "tool_call_id", None)
        if tcid:
            done_ids.add(tcid)

    # 收集所有「已发起但还没回结果」的 tool_call
    open_calls: list[dict] = []
    for m in messages:
        for tc in getattr(m, "tool_calls", None) or []:
            if tc["id"] not in done_ids:
                open_calls.append(tc)
    if not open_calls:
        return {}

    # 把这些 open_calls 匹配到 DB 里等着回填的工具行（_consume 当初为每个 tool_call 存了
    # 一条 kind='tool' text='' 的行）。同名同参可能有多条，用 used 集合避免一行被认领两次。
    result = await db.execute(
        select(DBMessage)
        .where(
            DBMessage.session_id == session_id,
            DBMessage.kind == "tool",
            DBMessage.text == "",
        )
        .order_by(DBMessage.id.asc())
    )
    tool_rows = list(result.scalars().all())

    pending: dict[str, tuple[str, dict, DBMessage]] = {}
    used: set[int] = set()
    for tc in open_calls:
        for row in tool_rows:
            if row.id in used:
                continue
            if row.tool_name == tc["name"] and (row.tool_args or {}) == (tc.get("args") or {}):
                pending[tc["id"]] = (tc["name"], tc.get("args") or {}, row)
                used.add(row.id)
                break
    return pending


async def _consume(
    agent,
    graph_input,
    thread_id: str,
    *,
    session_id: str,
    summary_text: str,
    model: str,
    db: AsyncSession,
    db_lock: asyncio.Lock,
    user_id: str,
    initial_pending: dict[str, tuple[str, dict, DBMessage]] | None = None,
) -> AsyncGenerator[str, None]:
    """消费 agent.astream(...) 的事件流,翻译成 SSE + 落库副作用。

    agent_loop(发新消息)和 app.api.ask_result 的 resume 端点共用这一段:前者传
    graph_input={"messages": messages},后者传 Command(resume=answer);两边各自
    准备好输入 + thread_id 后,消费 / 收尾逻辑完全一致。

    initial_pending:resume 时补种 pending 字典用。resume 是一次全新的 astream()
    调用 —— 上一轮 ask_user 的 tool_call 是在【上一次】(被 interrupt 打断的)调用里
    产出的,这次不会重新产出那个 "model" 节点事件,所以 pending 天然是空的;不补种的话,
    resume 后 "tools" 节点回传的 ToolMessage 会因为按 tool_call_id 查不到而被静默丢弃
    (答案存不进 DB、前端也收不到 tool_result)。调用方(ask_result)负责从 DB 查出那条
    待回填的 kind='tool' 消息,连同 tool_call_id 一并传进来。
    """
    final_assistant_text = ""
    final_reasoning_payload: dict | None = None
    wrote_files = False
    truncated = False
    pending: dict[str, tuple[str, dict, DBMessage]] = dict(initial_pending or {})
    # 「同批含 check_build」时被抢先补发过 file_write 的 tool_call_id 集合 ——
    # tools 节点回收结果时据此跳过重发，避免同一文件的 file_write 发两遍（见 _early_file_write）。
    early_written: set[str] = set()

    # ── 工具卡「流式提前亮」用的累积状态 ──
    announced_tools: set[str] = set()
    path_sent: set[str] = set()
    tool_chunk_args: dict[str, str] = {}
    tool_chunk_idx: dict[int, str] = {}
    tool_chunk_name: dict[str, str] = {}

    config = {"configurable": {"thread_id": thread_id}, "recursion_limit": RECURSION_LIMIT}

    try:
        # 同时开 updates(节点边界,做副作用)+ messages(token 流)。
        #
        # 【为什么文字增量不在这里直接下发】messages 模式是"模型正在吐这条消息"时的
        # 实时 token 流,这时候还不知道这条消息最终会不会被 NoBluffMiddleware 判定为
        # 嘴炮而打回重来（见 app.agents.middleware 顶部说明）——判定发生在这条消息
        # 【完整生成之后】。真事故:曾经这里 token 一来就立刻 yield message_delta,
        # 于是嘴炮文案原样打字机式地展示给了用户,等它被打回重新生成、真正调用了
        # 工具,用户看到的就是"AI 先吹了一遍牛、又开始干活"（工具卡出现在嘴炮文字
        # 之后）——即便后端从没把这段嘴炮文字存过库,呈现层已经把假象喂给用户了。
        #
        # 现在改成:文字只在下面 updates 模式里、确认这条消息"不会再被打回"的两个
        # 时机才整段一次性下发 ——①这条消息带了 tool_calls（tool_calls 存在本身就是
        # NoBluffMiddleware 判定"不算嘴炮"的充分条件，见 middleware.aafter_model 的
        # 第一行判断，可以立刻放行）；②真正跑到收尾阶段（本轮不会再回 model 节点了）。
        # messages 模式这里只留 tool_call_chunks 的早出卡逻辑（和嘴炮风险无关,write_file
        # 的参数早到早展示,不用等文字/整轮结束）。
        async for mode, chunk in agent.astream(
            graph_input,
            stream_mode=["updates", "messages"],
            config=config,
        ):
            # ── messages 模式:LLM 的 token 增量,只用来做工具卡早出卡 ──
            if mode == "messages":
                msg, meta = chunk
                if meta.get("langgraph_node") == "model":
                    for tcc in getattr(msg, "tool_call_chunks", None) or []:
                        idx = tcc.get("index") or 0
                        cid = tcc.get("id")
                        if cid:
                            tool_chunk_idx[idx] = cid
                            tool_chunk_args[cid] = tcc.get("args") or ""
                            tool_chunk_name[cid] = tcc.get("name") or ""
                        else:
                            cid = tool_chunk_idx.get(idx)
                            if cid is not None:
                                tool_chunk_args[cid] += tcc.get("args") or ""
                        if not cid:
                            continue
                        name = tool_chunk_name.get(cid, "")
                        if name and cid not in announced_tools:
                            announced_tools.add(cid)
                            print(f"[tool_call·流式提前·出卡] name={name}")
                            yield sse({"type": "tool_call", "name": name, "args": {}, "id": cid})
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
                if node_name == "__interrupt__":
                    # ask_user 触发了 interrupt():图状态已经存进 checkpointer,这次
                    # astream() 到此为止 —— 不做收尾三件套(不存最终文本、不打版本快照、
                    # 不计费,这一轮还没真正结束),也【不】清理 thread(还等着 resume)。
                    # 前端收到这个事件后要保持"等待回答"的禁用态,而不是当成流正常结束。
                    yield sse({"type": "awaiting_answer"})
                    return

                node_messages = update.get("messages", []) if isinstance(update, dict) else []

                if node_name == "model":
                    for m in node_messages:
                        response_metadata = m.response_metadata or {}
                        finish_reason = response_metadata.get(
                            "finish_reason"
                        ) or response_metadata.get("stop_reason")
                        if m.invalid_tool_calls or _is_truncation_reason(finish_reason):
                            print(
                                f"[截断] finish_reason={finish_reason} "
                                f"invalid_tool_calls={m.invalid_tool_calls}"
                            )
                            yield sse({
                                "type": "error",
                                "message": "模型输出超长被截断,文件没写完。请把需求拆小,或分多次生成。",
                            })
                            final_reasoning_payload = None
                            truncated = True
                            break

                        reasoning_payload = _reasoning_payload(m)
                        text = extract_text(m)
                        if m.tool_calls:
                            # 这一轮又调了工具,说明之前(若有)攒着没发的
                            # final_assistant_text 只是嘴炮重试前的半成品候选——
                            # 真调用工具证明它不是"这一轮的最终回复",作废丢弃,
                            # 避免收尾时把这段旧文字和这次真实工作的回复一起冒出来。
                            final_assistant_text = ""
                            final_reasoning_payload = None
                            yield sse(reasoning_payload)
                            await _save_reasoning_message(
                                db, db_lock, session_id, reasoning_payload
                            )
                            if text:
                                print(f"[response] content={text} (同轮调用了工具)")
                                # 带 tool_calls 的消息不可能被 NoBluffMiddleware 判定为嘴炮
                                # （见 middleware.aafter_model 第一行判断),此刻就能放心下发。
                                yield sse({"type": "message_delta", "text": text})
                                await _save_message(db, db_lock, session_id, "assistant", text)
                            for tc in m.tool_calls:
                                print(f"[tool_call] name={tc['name']} args={list(tc['args'].keys())}")
                                yield sse({"type": "tool_call", "name": tc["name"], "args": tc["args"], "id": tc["id"]})
                                if tc["name"] == "check_build":
                                    # ── 竞态防护：同批若还有 write_file/edit_file，它们真正的 file_write
                                    # 事件会被 tools 节点屏障拖到 check_build 之后才发（见 _early_file_write
                                    # 的详细说明）。这里在 arm+preview_refresh 之前，用这些工具自己的 args
                                    # 把 file_write 抢先补发出去，保证前端预览构建到的是这一批的新内容，
                                    # 而不是改动前的旧文件（否则 check_build 会误报「构建通过」）。
                                    # early_written 记下已抢发过的 tool_call_id，tools 节点分支据此跳过重发。
                                    for other in m.tool_calls:
                                        if other["id"] == tc["id"] or other["id"] in early_written:
                                            continue
                                        if other["name"] not in ("write_file", "edit_file"):
                                            continue
                                        ev = await _early_file_write(db, db_lock, session_id, other)
                                        if ev is not None:
                                            wrote_files = True
                                            early_written.add(other["id"])
                                            yield sse(ev)
                                    build_store.arm(session_id)
                                    yield sse({"type": "preview_refresh"})
                                # ask_user 不需要类似的"武装会合点"：它的问题内容已经通过上面
                                # 这条 tool_call 事件的 args 字段（questions）下发给前端了，
                                # 等待 / 恢复完全交给 interrupt() + checkpointer（见上面
                                # __interrupt__ 分支），不需要在这里额外记录任何东西。
                                tool_msg = await _save_message(
                                    db, db_lock, session_id, "assistant", "", kind="tool",
                                    tool_name=tc["name"], tool_args=tc["args"],
                                )
                                pending[tc["id"]] = (tc["name"], tc["args"], tool_msg)
                        else:
                            # 零 tool_calls 的话是 NoBluffMiddleware 唯一可能打回重来的对象
                            # （见 middleware.aafter_model)：这里先只存进变量、不下发 SSE、
                            # 不落库。若真被判定嘴炮,图会跳回 model 节点重新生成,这里会被
                            # 下一次的赋值直接覆盖掉,这段话就当没出现过;若没被打回,下面
                            # astream() 循环会自然走完(图到 END,不会再有新的 model 节点
                            # 更新了)——只有到那时候(见收尾处)才是"确认不会再被打回"的
                            # 唯一时机,才第一次把它下发给前端 + 存库。
                            final_assistant_text = text
                            final_reasoning_payload = reasoning_payload
                            print(f"[最终回复候选] content={text}")
                    if truncated:
                        break

                elif node_name == "tools":
                    for tm in node_messages:
                        name, args, tool_msg = pending.get(tm.tool_call_id, (None, None, None))
                        if name is None:
                            continue
                        tool_result = str(tm.content or "")

                        capped = (
                            tool_result
                            if len(tool_result) <= TOOL_RESULT_CAP
                            else tool_result[:TOOL_RESULT_CAP] + "\n…（结果过长已截断）"
                        )
                        tool_msg.text = capped
                        async with db_lock:
                            await db.commit()
                        yield sse({"type": "tool_result", "id": tm.tool_call_id, "result": capped})

                        if name == "check_build":
                            print(f"[check_build] {tool_result}")

                        # write_file / edit_file：若这条已在 check_build 同批里被 _early_file_write
                        # 抢先补发过（id 在 early_written 里），这里就只落 tool_result、不再重发
                        # file_write，避免前端收到同一文件两遍。
                        elif name == "write_file":
                            wrote_files = True
                            if tm.tool_call_id not in early_written:
                                yield sse({
                                    "type": "file_write",
                                    "path": args["path"],
                                    "content": args["content"],
                                })
                        elif name == "edit_file" and tool_result == f"已编辑 {args['path']}":
                            if tm.tool_call_id in early_written:
                                wrote_files = True
                            else:
                                async with db_lock:
                                    res = await db.execute(
                                        select(File.content).where(
                                            File.session_id == session_id,
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

        # ── 收尾(正常结束 / 截断 break 都会走到这里;__interrupt__ 分支已在上面 return 掉了)──
        # 到这里 astream() 已经自然走完、图不会再跳回 model 节点重新生成了 ——
        # 也就是说如果 final_assistant_text 有值,它已经【确认】不是嘴炮(没被
        # NoBluffMiddleware 打回),现在才是第一次把这段话下发给前端的时机。
        if final_reasoning_payload:
            yield sse(final_reasoning_payload)
            await _save_reasoning_message(
                db, db_lock, session_id, final_reasoning_payload
            )
        if final_assistant_text:
            yield sse({"type": "message_delta", "text": final_assistant_text})
            await _save_message(db, db_lock, session_id, "assistant", final_assistant_text)

        if wrote_files:
            version = await snapshot_current_files(
                db, session_id, summary=summary_text[:100]
            )
            if version is not None:
                yield sse({"type": "version", "version_id": version.id, "seq": version.seq})

        if not truncated:
            await _charge_user(db, user_id, model)

        # 这一轮真正跑完(没有 pending interrupt),清掉这次的 checkpoint。
        await _cleanup_thread(thread_id)
        yield sse({"type": "done"})

    except GraphRecursionError:
        yield sse({
            "type": "error",
            "message": "已达最大轮次,自动停止以防死循环。",
        })
        await _cleanup_thread(thread_id)
        yield sse({"type": "done"})
    except Exception as e:
        yield sse({"type": "error", "message": str(e)})
        await _cleanup_thread(thread_id)
        yield sse({"type": "done"})


async def agent_loop(
    req: ChatRequest, db: AsyncSession, user_id: str
) -> AsyncGenerator[str, None]:
    """喂入历史 → 委托 _consume 消费图的事件流。

    user_id：本轮请求者。用于「成功才扣」——干净跑完时按模型倍率给他扣点(见 _consume 收尾处)。
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
    # 实际的 llm/tools/agent 构造统一收口在 build_round_agent（见下面 create_agent 处），
    # 那里已做 error+done 兜底：此处已在 StreamingResponse 内部、HTTP 200 头早已发出，
    # 任何裸抛的异常都会让前端只看到流凭空中断（既无 error 也无 done、UI 卡在「思考中」）。

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
        last_user, file_sync_events = prepared
        for ev in file_sync_events:
            yield sse(ev)
    else:
        last_user = await _save_message(
            db, db_lock, req.session_id, "user", req.message, images=req.images or None
        )

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

    # system prompt 已由下面 create_agent 注入,这里只装对话历史。
    # 用户消息若带图片,用 build_human_content 拼成多模态 content 回放给 LLM ——
    # 这样不止当前这轮,过去几轮发过的图也会重新带上,模型能持续「看到」它们。
    # 代价是历史里的图每轮都重发,token 偏贵;练手项目图少,可接受(要省可改成只带最后一条)。
    messages = []
    for m in history:
        if m.role == "user":
            messages.append(HumanMessage(content=build_human_content(m.text, m.images)))
        else:
            messages.append(AIMessage(content=m.text))

    # 2.5 当前项目文件树，见 _file_tree_note 说明。必须放在上面「重试回退」之后查，
    # 才能保证拿到的是这一轮真正开始时的准确状态。
    tree_note = await _file_tree_note(db, req.session_id)

    # checkpointer：ask_user 的 interrupt()/resume 需要它持久化图状态(见 app.checkpointer)。
    # 这一步理论上不太会失败,但和上面构造 llm/tools 一样做同款 error+done 兜底,
    # 避免任何异常在 StreamingResponse 内部裸抛,把前端卡在「思考中」出不来。
    try:
        agent = build_round_agent(db, req.session_id, req.model, db_lock, tree_note)
    except HTTPException as e:
        yield sse({"type": "error", "message": str(e.detail)})
        yield sse({"type": "done"})
        return
    except Exception as e:
        yield sse({"type": "error", "message": str(e)})
        yield sse({"type": "done"})
        return

    # thread_id 绑定"这一轮"而不是整个 session（关键设计取舍，见 app.checkpointer 顶部
    # 说明）：本项目每次请求都从 DB 重新拼出全部历史喂给图，不依赖 LangGraph 原生的跨轮
    # 记忆；若 thread_id 固定绑 session，checkpointer 里持久化的历史消息对象会和这里重新
    # 拼出来的全新对象冲突。用触发本轮的用户消息 id 保证每轮唯一，生命周期正好对应
    # "这一轮开始 → 可能被 interrupt → 被 resume → 真正跑完"这一个闭环。
    thread_id = f"{req.session_id}:{last_user.id}"

    async for event in _consume(
        agent,
        {"messages": messages},
        thread_id,
        session_id=req.session_id,
        summary_text=req.message,
        model=req.model,
        db=db,
        db_lock=db_lock,
        user_id=user_id,
    ):
        yield event

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
from dataclasses import dataclass, field
from datetime import date

import httpx
from fastapi import HTTPException
from langchain.agents import create_agent
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langgraph.errors import GraphRecursionError
from pydantic import BaseModel
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app import build_store
from app.agents.message_content import build_human_content
from app.agents.middleware import (
    NoBluffMiddleware,
    ScreenshotVisionMiddleware,
    screenshot_from_artifact,
)
from app.agents.prompts import SYSTEM_PROMPT
from app.agents.tools import (
    BuildCheckReuseState,
    build_tools,
    normalize_ask_user_questions,
    project_files_fingerprint,
)
from app.agents.version_naming import name_next_generated_version
from app.checkpointer import get_checkpointer
from app.llm import build_llm, models_by_id
from app.model_providers import (
    reasoning_delta_text,
    reasoning_observation,
    split_inline_thinking,
)
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
    # 是否开启深度思考。None 保留厂商默认；布尔值只允许用于后台已探测到思考能力的模型。
    thinking: bool | None = None
    # 重试标记。为 True 时:不新存用户消息,而是复用「最新一轮的用户消息」当 prompt
    # 重新生成一遍,并把喂给 LLM 的历史截到那条消息为止 —— 丢掉它之后的旧回复,
    # 让模型重新作答而不是接着自己已答的内容往下说。重生成和普通一轮一样,
    # 结尾对「当前」文件态打一个新版本快照（单线递增、不删旧版本,所以是 v8 而不是改 v3）。
    # 此时 message / images 由前端留空,真正的 prompt 从库里捞最后一条用户消息。
    retry: bool = False


def successful_file_tool_path(
    name: str, args: object, tool_result: str
) -> str | None:
    """识别真正成功的写文件工具结果，并安全取出路径。

    部分模型偶尔会发出缺少必填参数的工具调用。LangChain 会把校验错误作为
    ToolMessage 返回；这里必须把它当成可恢复的工具失败，不能再用 ``args["path"]``
    触发 KeyError、终止整条 SSE。
    """
    if not isinstance(args, dict):
        return None
    path = args.get("path")
    if not isinstance(path, str) or not path:
        return None
    expected_prefix = {
        "write_file": "已写入",
        "edit_file": "已编辑",
    }.get(name)
    if expected_prefix is None or tool_result != f"{expected_prefix} {path}":
        return None
    return path


# ── SSE 工具函数 ────────────────────────────────────────────────────────────────

def sse(event: dict) -> str:
    return f"data: {json.dumps(event, ensure_ascii=False)}\n\n"


# 上游已经返回响应头、却在流式 body 中途断开时，OpenAI SDK 自带的 max_retries
# 不会再接管。这里只允许从 LangGraph 明确停在 model 节点的 checkpoint 恢复一次；
# tools 节点绝不自动重放，避免 edit_file/check_build 产生二次副作用。
MODEL_STREAM_RECOVERY_LIMIT = 1
MODEL_STREAM_RECOVERY_BACKOFF_S = 1.0


def _exception_chain(exc: BaseException):
    """遍历异常包装链，并防住第三方 SDK 形成循环引用。"""
    seen: set[int] = set()
    current: BaseException | None = exc
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        yield current
        current = current.__cause__ or current.__context__


def _is_retryable_model_stream_error(exc: BaseException) -> bool:
    """只识别模型响应体读取阶段的瞬时传输错误。

    HTTP 4xx/5xx、参数校验、JSON 解析和业务异常都不能误重试。OpenAI/Anthropic
    SDK 常把底层 httpx 异常包进 APIConnectionError，因此需要沿 cause/context 查找。
    """
    disconnect_markers = (
        "peer closed connection without sending complete message body",
        "incomplete chunked read",
        "server disconnected",
    )
    for current in _exception_chain(exc):
        if isinstance(current, httpx.TransportError):
            return True
        # langchain-openai 的相邻分片超时类型是私有类，不直接依赖其导入路径；
        # 只按精确类名识别，避免把任意 TimeoutError 当成模型网络故障。
        if type(current).__name__ in {
            "StreamChunkTimeoutError",
            "APIConnectionError",
            "APITimeoutError",
        }:
            return True
        message = str(current).lower()
        if any(marker in message for marker in disconnect_markers):
            return True
    return False


async def _model_checkpoint_can_resume(agent, config: dict) -> bool:
    """确认失败点只剩 model 节点待跑，拒绝跨工具边界自动恢复。"""
    try:
        state = await agent.aget_state(config)
    except Exception as exc:
        print(
            "[模型流恢复] 读取 checkpoint 失败，放弃自动恢复: "
            f"{type(exc).__name__}: {exc}",
            flush=True,
        )
        return False
    tasks = tuple(getattr(state, "tasks", ()) or ())
    return (
        tuple(getattr(state, "next", ()) or ()) == ("model",)
        and not (getattr(state, "interrupts", ()) or ())
        and len(tasks) == 1
        and getattr(tasks[0], "name", None) == "model"
        and bool(getattr(tasks[0], "error", None))
    )


async def _astream_with_model_recovery(
    agent,
    graph_input,
    *,
    config: dict,
):
    """消费图事件；模型传输中断时从安全 checkpoint 有限恢复。

    yield 的 ``generation_retry`` 是本文件内部哨兵，由 ``_consume`` 转成 SSE。
    重试输入必须是 None，表示沿同一 thread 的 pending model 节点继续，不能再次注入
    用户消息。模型节点未完整返回前 LangGraph 不会进入 tools，所以已流出的工具参数
    只是 UI 草稿，还没有执行文件操作。
    """
    next_input = graph_input
    recoveries = 0
    while True:
        try:
            async for item in agent.astream(
                next_input,
                stream_mode=["updates", "messages"],
                config=config,
            ):
                yield item
            return
        except Exception as exc:
            can_retry = (
                recoveries < MODEL_STREAM_RECOVERY_LIMIT
                and _is_retryable_model_stream_error(exc)
                and await _model_checkpoint_can_resume(agent, config)
            )
            if not can_retry:
                raise

            recoveries += 1
            print(
                "[模型流恢复] 上游流中断，从 model checkpoint 自动恢复 "
                f"{recoveries}/{MODEL_STREAM_RECOVERY_LIMIT}: "
                f"{type(exc).__name__}: {exc}",
                flush=True,
            )
            yield (
                "generation_retry",
                {
                    "attempt": recoveries,
                    "max_attempts": MODEL_STREAM_RECOVERY_LIMIT,
                },
            )
            await asyncio.sleep(MODEL_STREAM_RECOVERY_BACKOFF_S)
            next_input = None


def preview_device_event(tool_call: dict) -> dict | None:
    """把画布工具调用翻译成前端事件；完整参数到齐后才允许实际切换。"""
    if tool_call.get("name") != "set_preview_device":
        return None
    args = tool_call.get("args") or {}
    device = args.get("device")
    if device not in {"desktop", "mobile"}:
        return None
    return {
        "type": "preview_device",
        "device": device,
        "id": tool_call.get("id") or "",
    }


def sandbox_preview_event(check_id: str, artifact: object) -> dict | None:
    """把 check_build 已完成的服务端构建结果翻译成前端预览事件。

    前端拿到这个事件后直接加载 Worker 已产出的 capability URL，不能再次提交构建，
    否则刷新后重连时会与后台任务争抢单并发 Worker 并收到 429。
    """
    if not isinstance(artifact, dict):
        return None
    preview = artifact.get("sandbox_preview")
    if not isinstance(preview, dict) or not isinstance(preview.get("ok"), bool):
        return None
    device = preview.get("device")
    if device not in {"desktop", "mobile"}:
        device = "desktop"
    return {
        "type": "preview_refresh",
        "id": check_id,
        "ok": preview["ok"],
        "preview_url": (
            preview.get("preview_url")
            if isinstance(preview.get("preview_url"), str)
            else None
        ),
        "logs": preview.get("logs") if isinstance(preview.get("logs"), str) else "",
        "errors": (
            preview.get("errors") if isinstance(preview.get("errors"), str) else ""
        ),
        "device": device,
    }


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
        # cancel 只是发出请求，不是完成屏障。必须等待当前 __anext__ 真正退出，再显式
        # aclose 暂停在 yield 处的内层生成器，确保 _consume/build_store 的 finally 已执行。
        if not next_task.done():
            next_task.cancel()
        await asyncio.gather(next_task, return_exceptions=True)
        aclose = getattr(it, "aclose", None)
        if aclose is not None:
            await aclose()


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


def _restored_check_cacheability(
    content: str,
    *,
    has_screenshot: bool,
) -> bool | None:
    """断线恰好发生在 tools 节点后时，从 ToolMessage 恢复结果分类。

    正常路径由 check_build 工具直接登记；这里只处理旧工具闭包状态已经随请求消失、
    但 ToolMessage 被 checkpointer 保存下来的续跑边界。
    """
    if "同一批工具调用里出现了多个 check_build" in content:
        return None
    if has_screenshot:
        return True
    if content.startswith("预览构建失败（编译没通过）"):
        return True
    if content.startswith("构建通过，但预览") and any(
        marker in content for marker in ("报错", "失败", "问题")
    ):
        return True
    return False


def _synthetic_duplicate_check_result() -> dict:
    """给同一 AIMessage 里的额外 check_build 一个即时内部结果。"""
    return {
        "ok": False,
        "errors": (
            "同一批工具调用里出现了多个 check_build；"
            "本次只执行第一项，请等待其结果后再检查。"
        ),
        "runtime": False,
        "visual": False,
        "screenshot_id": None,
        "_synthetic": True,
    }


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


def _reasoning_payload(
    response: object,
    streamed_text: str = "",
) -> dict | None:
    """仅把真实返回了推理正文的响应归一成前端思考事件。

    adaptive thinking 可以对简单请求完全跳过思考；部分接口也只返回 token
    统计而没有可展示正文。这两种情况都不生成占位卡，避免前端误显示
    “已完成思考”。若完整消息没保留正文，则使用已收到的流式正文完成卡片。
    """
    observation = reasoning_observation(response)
    content = observation.content.strip() or streamed_text.strip()
    if not content:
        return None
    truncated = len(content) > REASONING_CONTENT_CAP
    if truncated:
        content = content[:REASONING_CONTENT_CAP] + "\n\n…（思考过程过长，已截断）"

    return {
        "type": "reasoning",
        "text": content,
        "tokens": observation.tokens or None,
        "fallback": False,
        "truncated": truncated,
    }

# 从（可能还没写完的）工具参数 JSON 片段里抠出 path 值。
# 用途：write_file 的整个文件内容是作为 content 参数被逐 token 生成的，要等它全写完
# 工具调用才"完整"、卡片才发得出 —— 这就是"写完才看到卡片、还得等好久"的根源。
# path 排在参数 JSON 最前面，几个 token 就到，所以一旦正则匹配上 path，就能在内容还没
# 写完时把工具卡提前亮出来。((?:[^"\\]|\\.)*) 容忍路径里可能出现的转义字符。
_PATH_RE = re.compile(r'"path"\s*:\s*"((?:[^"\\]|\\.)*)"')


async def _charge_user(
    db: AsyncSession,
    user_id: str,
    model: str,
    model_cost: int,
) -> None:
    """一轮「干净跑完」后按模型倍率扣点。只在成功路径调用（见 agent_loop 收尾）。

    扣费时机是「成功才扣」：报错 / 截断 / 用户中断都不会走到这里，所以没扣过、也无需返还。
    隔天重置就在这里发生：daily_date 不是今天 → 先把 daily_used 清零、再累加本轮 cost。

    model_cost 在构造本轮 agent 前从注册表捕获。这里不能再按 model 查询可变注册表：
    管理员可能在生成期间改名或调整倍率，收尾必须仍按本轮开始时的快照计费。

    自己吞掉异常：计费环节出问题也不该污染「已经成功」的 SSE 流——宁可这轮漏扣，
    也不要在 done 之前抛错、把一次成功的生成变成给用户看的报错。
    """
    try:
        user = await db.get(User, user_id)
        if user is None:
            return
        today = date.today()
        if user.daily_date != today:
            user.daily_used = 0
            user.daily_date = today
        user.daily_used += model_cost
        await db.commit()
        print(
            f"[扣费] user={user_id} model={model} cost={model_cost}"
            f" → daily_used={user.daily_used}"
        )
    except Exception as e:
        print(f"[扣费失败] user={user_id} model={model}: {type(e).__name__}: {e}")


async def _delete_thread_checkpoint(thread_id: str) -> None:
    """严格删除一轮的 LangGraph 状态。

    与正常收尾时的 best-effort 清理不同，重新生成必须先确保旧 checkpoint 已删除；
    否则同一个 ``session_id:last_user_id`` 会从 ask_user 的 interrupt 处继续执行，
    模型就会把“重新生成”误认为用户跳过了问题。
    """
    await get_checkpointer().adelete_thread(thread_id)


async def _prepare_retry(
    req: ChatRequest, db: AsyncSession
) -> tuple[DBMessage, list[dict]] | None:
    """重试前的准备:把「最新一轮」当作从没发生过,让 AI 能真正重新生成。

    为什么需要回退文件:重试若直接基于「当前文件」跑,AI 会看到需求其实已经实现了,
    于是什么都不改、也不产新版本 —— 表现就是"重试没反应"。所以必须先把文件回退到
    「这一轮开始前」的状态,AI 才会从头再写一遍。

    具体做五件事:
      1. 捞「最新一轮的用户消息」当本轮 prompt(回填到 req.message,供版本快照 summary 用);
      2. 严格删除这轮可能遗留的 LangGraph checkpoint，确保从原始 prompt 重新开始，
         而不是从 ask_user 的 interrupt 暂停点继续;
      3. 把文件回退到这一轮开始前的状态 —— 即它的版本卡之前最近一张版本卡对应的快照;
         若它之前没有任何版本卡(这是第一轮),就回退到初始模板;
      4. 删掉这条用户消息之后的所有对话消息(旧回复 / 工具卡 / 版本卡),让对话看起来像
         把这条消息重新发了一遍。注意只删 messages,versions / version_files 快照一律不动,
         所以生成过的版本全部保留、仍能在「版本历史」里回滚;
      5. 算出「回退后该同步给前端的文件事件」并返回,调用方负责 yield 出去。

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

    # 2. retry 会复用同一条 user 消息，因此 thread_id 也完全相同。必须先严格清掉
    # ask_user / 断连留下的旧图状态，否则 create_agent 会直接从旧 checkpoint 续跑。
    await _delete_thread_checkpoint(f"{req.session_id}:{last_user.id}")

    # 3a. 当前文件(= 旧的最后一轮结束后的状态),用来和回退目标做 diff,算出哪些要删
    res = await db.execute(select(File).where(File.session_id == req.session_id))
    old_contents = {f.path: f.content for f in res.scalars().all()}

    # 3b. 找「这一轮开始前」的版本:版本卡在 last_user 之前的最后一张。
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

    # 3c. 算出回退目标的文件状态 pre_round（path -> content）
    target_vid = prev_card.tool_args.get("version_id") if (prev_card and prev_card.tool_args) else None
    if target_vid is not None:
        res = await db.execute(
            select(VersionFile).where(VersionFile.version_id == target_vid)
        )
        pre_round = {vf.path: vf.content for vf in res.scalars().all()}
    else:
        # 它之前没有任何版本 = 这是第一轮,回到初始模板（和新建会话时预置的一致）
        pre_round = load_template("vite-react")

    # 4a. 用 pre_round 整体覆盖 files 表（删旧建新,和 versions.restore_version 同款写法）
    await db.execute(delete(File).where(File.session_id == req.session_id))
    db.add_all([
        File(session_id=req.session_id, path=path, content=content)
        for path, content in pre_round.items()
    ])

    # 4b. 删掉 last_user 之后的所有对话消息（versions/version_files 不动）
    await db.execute(
        delete(DBMessage).where(
            DBMessage.session_id == req.session_id,
            DBMessage.id > last_user.id,
        )
    )
    await db.commit()

    # 5. 算出回退后要同步给前端的文件事件：旧有新无的删、内容变了的重发。
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


def _stored_tool_args(args: dict | None, tool_call_id: str) -> dict:
    """工具行额外保存 LangGraph 的调用 ID，刷新后仍能幂等更新同一张卡。"""
    return {
        **(args or {}),
        "_tool_call_id": tool_call_id,
    }


def _public_tool_args(args: dict | None) -> dict:
    """去掉只供恢复/缓存使用的内部字段，得到模型原始工具参数。"""
    return {
        key: value
        for key, value in (args or {}).items()
        if key != "_tool_call_id" and not key.startswith("_build_")
    }


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
    死死拖在后面；服务端构建若直接读取数据库，也会拿到同批写入前的旧文件。

    对策：一旦发现某批 tool_calls 里带 check_build，就在工具执行前用各写文件工具
    **自己的 args** 把 file_write 抢先折算出来发给前端，并把同批内容叠加进服务端构建
    快照。返回可直接 yield 的事件 dict；拿不到可靠内容（参数缺失 / edit 命中不唯一）时返回
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
        if content is None:
            return None
        # 唯一命中时预应用编辑后的内容；找不到/多处命中意味着 edit_file 最终会拒绝写入，
        # 此时把数据库当前原文发给前端，仍能保证紧随其后的 check_build 构建真实文件态。
        next_content = content.replace(old, new, 1) if content.count(old) == 1 else content
        return {"type": "file_write", "path": path, "content": next_content}
    return None


async def _cleanup_thread(thread_id: str) -> None:
    """一轮真正跑完(没有 pending interrupt)后清掉这次的 checkpoint。

    messages 表才是历史的唯一真相源,checkpointer 只是"这一轮进行中"的临时状态
    (见 app.checkpointer 顶部说明)——不清理的话 checkpoint 库会无限增长。

    自己吞掉异常,理由同 _charge_user:清理失败不该污染已经成功 / 已经报错收尾的 SSE 流。
    """
    try:
        await _delete_thread_checkpoint(thread_id)
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


async def restore_round_build_reuse_state(
    db: AsyncSession,
    session_id: str,
    thread_id: str,
    db_lock: asyncio.Lock,
    build_reuse_state: BuildCheckReuseState,
) -> bool:
    """恢复同一用户消息触发轮次里的最近一次有效构建缓存。

    ``ignore`` 是同批额外 check_build 的合成结果，向前继续找；``clear`` 或没有新元数据
    表示最近一次真实检查不完整，必须停止，不能误用更早的截图。
    """
    try:
        last_user_id = int(thread_id.rsplit(":", 1)[1])
    except (ValueError, IndexError):
        return False

    async with db_lock:
        result = await db.execute(
            select(DBMessage)
            .where(
                DBMessage.session_id == session_id,
                DBMessage.id > last_user_id,
                DBMessage.kind == "tool",
                DBMessage.tool_name == "check_build",
                DBMessage.text != "",
            )
            .order_by(DBMessage.id.desc())
            .limit(50)
        )
        rows = list(result.scalars().all())

    for row in rows:
        metadata = row.tool_args or {}
        action = metadata.get("_build_cache")
        if action in ("ignore", "reuse"):
            continue
        if action != "store":
            return False
        fingerprint = metadata.get("_build_fingerprint")
        if not isinstance(fingerprint, str) or not fingerprint or not row.text:
            return False
        build_reuse_state.restore(fingerprint, row.text)
        return True
    return False


def build_round_agent(
    db: AsyncSession,
    session_id: str,
    model: str,
    db_lock: asyncio.Lock,
    tree_note: str,
    thinking: bool | None = None,
    build_reuse_state: BuildCheckReuseState | None = None,
):
    """按本轮选的模型重建 llm/tools/agent（含 checkpointer + NoBluffMiddleware）。

    与 agent_loop 首次创建 agent 的装配方式完全一致，供 resume / ask_result 复用。
    调用方负责先算好 tree_note（当下真实文件状态）和 db_lock；真正进入 _consume 时
    还要把同一个 build_reuse_state 传过去，让触发层和工具层共享幂等判定。
    """
    llm = build_llm(model, thinking=thinking)
    tools = build_tools(
        db,
        session_id,
        db_lock,
        build_reuse_state=build_reuse_state,
    )
    model_meta = models_by_id().get(model, {})
    agent = create_agent(
        llm,
        tools,
        system_prompt=SYSTEM_PROMPT + tree_note,
        checkpointer=get_checkpointer(),
        middleware=[
            ScreenshotVisionMiddleware(
                enabled=bool(model_meta.get("vision")),
                session_id=session_id,
            ),
            NoBluffMiddleware(llm),
        ],
    )
    return agent


@dataclass
class PendingToolRecovery:
    """从检查点恢复出的工具批次及其 UI/构建处理方式。"""

    pending: dict[str, tuple[str, dict, DBMessage]] = field(default_factory=dict)
    open_calls: list[dict] = field(default_factory=list)
    completed_calls: list[dict] = field(default_factory=list)
    replay_events: list[dict] = field(default_factory=list)
    primary_check_ids: set[str] = field(default_factory=set)
    suppressed_check_ids: set[str] = field(default_factory=set)
    synthetic_check_ids: set[str] = field(default_factory=set)
    wrote_files: bool = False


def _checkpoint_tool_state(
    state,
) -> tuple[list[list[dict]], dict[str, dict], list[ToolMessage], set[str]]:
    """拆出 open 批次、调用索引、尾部已完成结果和同批 secondary 检查。"""
    messages = state.values.get("messages", []) if state and state.values else []
    done_ids = {
        tcid
        for message in messages
        if (tcid := getattr(message, "tool_call_id", None))
    }
    open_batches: list[list[dict]] = []
    calls_by_id: dict[str, dict] = {}
    secondary_check_ids: set[str] = set()
    for message in messages:
        calls = list(getattr(message, "tool_calls", None) or [])
        calls_by_id.update({tc["id"]: tc for tc in calls})
        check_ids = [tc["id"] for tc in calls if tc["name"] == "check_build"]
        secondary_check_ids.update(check_ids[1:])
        batch = [
            tc
            for tc in calls
            if tc["id"] not in done_ids
        ]
        if batch:
            open_batches.append(batch)

    # state.next 已到 model、但 _consume 还没处理 tools update 时，消息尾部是一组
    # ToolMessage。只对账这一组；更早的结果早已正常落库，不能重新生成重复卡。
    trailing_tool_messages: list[ToolMessage] = []
    for message in reversed(messages):
        if isinstance(message, AIMessage):
            break
        if isinstance(message, ToolMessage):
            trailing_tool_messages.append(message)
    trailing_tool_messages.reverse()
    return (
        open_batches,
        calls_by_id,
        trailing_tool_messages,
        secondary_check_ids,
    )


async def reseed_pending_from_state(
    db: AsyncSession,
    session_id: str,
    thread_id: str,
    state,
    db_lock: asyncio.Lock,
    build_reuse_state: BuildCheckReuseState,
) -> PendingToolRecovery:
    """从检查点完整重建断线时尚未完成的工具批次。

    不能只查数据库空工具行：客户端可能在 ``tool_call`` / ``preview_refresh`` 的 yield
    边界断开，此时 LangGraph 已保存 AIMessage，但消费端尚未来得及落工具行。这里以
    checkpoint 为真相源，匹配已有行并为缺失的可见调用补行；同批额外 check_build 和
    命中同轮缓存的检查继续保持隐藏，不会因续跑变成新的自检卡。
    """
    (
        batches,
        calls_by_id,
        trailing_tool_messages,
        secondary_check_ids,
    ) = _checkpoint_tool_state(state)
    recovery = PendingToolRecovery(
        open_calls=[tc for batch in batches for tc in batch],
    )
    completed_pairs: list[tuple[dict, ToolMessage]] = []
    for tool_message in trailing_tool_messages:
        tc = calls_by_id.get(tool_message.tool_call_id)
        if tc is not None:
            completed_pairs.append((tc, tool_message))
    relevant_calls = [
        *[tc for tc, _tool_message in completed_pairs],
        *recovery.open_calls,
    ]
    if not relevant_calls:
        return recovery

    conditions = [
        DBMessage.session_id == session_id,
        DBMessage.kind == "tool",
    ]
    try:
        conditions.append(DBMessage.id > int(thread_id.rsplit(":", 1)[1]))
    except (ValueError, IndexError):
        pass

    async with db_lock:
        result = await db.execute(
            select(DBMessage)
            .where(*conditions)
            .order_by(DBMessage.id.asc())
        )
        tool_rows = list(result.scalars().all())

    # 优先按持久化 tool_call_id 精确认领。只有旧数据完全没有 ID 时，才允许按
    # name + public args 兜底；带着其它 ID 的陈旧空行绝不能抢占本次调用。
    matched_rows: dict[str, DBMessage] = {}
    used_row_ids: set[int] = set()
    for tc in relevant_calls:
        for row in tool_rows:
            if row.id in used_row_ids:
                continue
            stored_id = (row.tool_args or {}).get("_tool_call_id")
            if stored_id == tc["id"]:
                matched_rows[tc["id"]] = row
                used_row_ids.add(row.id)
                break

    for tc in relevant_calls:
        if tc["id"] in matched_rows:
            continue
        args = tc.get("args") or {}
        for row in reversed(tool_rows):
            if row.id in used_row_ids:
                continue
            stored_id = (row.tool_args or {}).get("_tool_call_id")
            if (
                not stored_id
                and not row.text
                and row.tool_name == tc["name"]
                and _public_tool_args(row.tool_args) == args
            ):
                matched_rows[tc["id"]] = row
                used_row_ids.add(row.id)
                break

    # 旧空行可能尚未保存 tool_call_id；补齐后，页面刷新再续跑仍能 upsert 同一张卡。
    if matched_rows:
        async with db_lock:
            for call_id, row in matched_rows.items():
                row.tool_args = {
                    **(row.tool_args or {}),
                    "_tool_call_id": call_id,
                }
            await db.commit()

    # ── tools 节点已完成、消费端尚未来得及落库：从 checkpoint 对账回填 ──
    for tc, tool_message in completed_pairs:
        call_id = tc["id"]
        name = tc["name"]
        args = tc.get("args") or {}
        tool_result = str(tool_message.content or "")

        hidden_check = name == "check_build" and (
            call_id in secondary_check_ids
            or "已跳过重复构建和截图" in tool_result
            or "同一批工具调用里出现了多个 check_build" in tool_result
        )
        if hidden_check:
            recovery.suppressed_check_ids.add(call_id)
            continue

        row = matched_rows.get(call_id)
        was_persisted = bool(row is not None and row.text)
        if row is None:
            row = await _save_message(
                db,
                db_lock,
                session_id,
                "assistant",
                "",
                kind="tool",
                tool_name=name,
                tool_args=_stored_tool_args(args, call_id),
            )

        capped = (
            tool_result
            if len(tool_result) <= TOOL_RESULT_CAP
            else tool_result[:TOOL_RESULT_CAP] + "\n…（结果过长已截断）"
        )
        row.text = capped
        screenshot_ref = None
        screenshot = screenshot_from_artifact(tool_message.artifact)
        if screenshot is not None:
            screenshot_ref = screenshot[1]
            row.images = [str(screenshot_ref["url"])]

        if name == "check_build":
            if not was_persisted:
                # ToolMessage 没携带“检查发生时”的文件摘要。断线后用户可能已经回滚/
                # 手动保存，绝不能拿恢复时的当前摘要给旧截图背书；只回填卡片并清缓存。
                build_reuse_state.prepare_check(
                    call_id,
                    None,
                    force_fresh=True,
                )
                build_reuse_state.note_fresh_result(
                    call_id,
                    cacheable=False,
                )
                build_reuse_state.finish_check(call_id, None, capped)
                row.tool_args = {
                    **_stored_tool_args(args, call_id),
                    "_build_cache": "clear",
                }
            if screenshot_ref is not None:
                row.tool_args = {
                    **(row.tool_args or _stored_tool_args(args, call_id)),
                    "_screenshot": screenshot_ref,
                }
        else:
            row.tool_args = _stored_tool_args(args, call_id)

        result_event = {
            "type": "tool_result",
            "id": call_id,
            "result": capped,
        }
        if screenshot_ref is not None:
            result_event["screenshot"] = screenshot_ref
        recovery.completed_calls.append(tc)
        recovery.replay_events.append(result_event)

        write_succeeded = (
            name == "write_file"
            and tool_result == f"已写入 {args.get('path')}"
        ) or (
            name == "edit_file"
            and tool_result == f"已编辑 {args.get('path')}"
        )
        path = args.get("path")
        if write_succeeded and isinstance(path, str):
            # 旧 write_file args 可能已被用户回滚。恢复 UI 必须以数据库此刻的真相为准，
            # 和 edit_file 一样重读当前内容；文件已不存在则显式删除本地草稿。
            async with db_lock:
                current = await db.execute(
                    select(File.content).where(
                        File.session_id == session_id,
                        File.path == path,
                    )
                )
                content = current.scalar_one_or_none()
            recovery.wrote_files = True
            recovery.replay_events.append(
                (
                    {"type": "file_write", "path": path, "content": content}
                    if content is not None
                    else {"type": "file_delete", "path": path}
                )
            )

    if recovery.completed_calls:
        async with db_lock:
            await db.commit()

    for batch in batches:
        has_same_batch_write = any(
            tc["name"] in ("write_file", "edit_file")
            for tc in batch
        )
        check_calls = [tc for tc in batch if tc["name"] == "check_build"]
        primary_check_id = check_calls[0]["id"] if check_calls else None
        fingerprint = None
        if check_calls and not has_same_batch_write:
            try:
                fingerprint = await project_files_fingerprint(
                    db,
                    session_id,
                    db_lock,
                )
            except Exception as exc:
                print(
                    "[resume] 文件摘要计算失败，本批检查执行真实构建: "
                    f"{type(exc).__name__}: {exc}"
                )

        for tc in batch:
            call_id = tc["id"]
            name = tc["name"]
            args = tc.get("args") or {}
            row = matched_rows.get(call_id)

            if name == "check_build":
                if call_id != primary_check_id:
                    build_reuse_state.prepare_check(
                        call_id,
                        fingerprint,
                        force_fresh=has_same_batch_write,
                    )
                    recovery.suppressed_check_ids.add(call_id)
                    if not build_reuse_state.should_reuse(call_id):
                        recovery.synthetic_check_ids.add(call_id)
                    continue

                # 已经有空行说明这张真实检查卡在断线前已落库；即使内容后来恰好回滚成
                # 旧摘要，也应完成原卡，不能把它悄悄留成永久 loading。
                reuse = build_reuse_state.prepare_check(
                    call_id,
                    fingerprint,
                    force_fresh=has_same_batch_write or row is not None,
                )
                if reuse:
                    recovery.suppressed_check_ids.add(call_id)
                    continue
                recovery.primary_check_ids.add(call_id)

            if row is None:
                row = await _save_message(
                    db,
                    db_lock,
                    session_id,
                    "assistant",
                    "",
                    kind="tool",
                    tool_name=name,
                    tool_args=_stored_tool_args(args, call_id),
                )
            recovery.pending[call_id] = (name, args, row)

    return recovery


async def _consume(
    agent,
    graph_input,
    thread_id: str,
    *,
    session_id: str,
    summary_text: str,
    model: str,
    model_cost: int,
    db: AsyncSession,
    db_lock: asyncio.Lock,
    user_id: str,
    initial_pending: dict[str, tuple[str, dict, DBMessage]] | None = None,
    initial_early_written: set[str] | None = None,
    initial_suppressed_check_ids: set[str] | None = None,
    initial_wrote_files: bool = False,
    emit_reasoning: bool = True,
    build_reuse_state: BuildCheckReuseState | None = None,
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

    initial_early_written / initial_suppressed_check_ids / initial_wrote_files 由断线续跑
    恢复器提供：分别避免重复发送预应用文件、保持隐藏检查身份，并确保 tools 节点已经
    完成但消费端尚未处理时，最终仍会为已落库的文件改动生成版本快照。

    emit_reasoning=False 表示本轮显式关闭思考：即使厂商仍返回推理字段，也不下发
    reasoning SSE、不生成兜底卡，并且不把 reasoning 消息持久化到数据库。

    build_reuse_state 必须与 build_round_agent 构造工具时使用的是同一个对象；否则 loop
    虽能跳过 preview_refresh，check_build 工具却看不到复用决定。
    """
    final_assistant_text = ""
    final_reasoning_payload: dict | None = None
    reasoning_seq = 0
    active_reasoning_id: str | None = None
    active_reasoning_text = ""
    # 模型常在同一条 AIMessage 里先说一句“我来处理”，随后开始生成工具参数。
    # write_file 的 content 可能很长，不能等整条消息结束才把这句开场展示出来。
    active_visible_text = ""
    emitted_tool_intro = ""
    # 模型流中断前若已经展示并落库过开场白，恢复后的同一个 model 节点不能再发一遍。
    # 该标记只约束恢复后的第一次模型调用，完整 model update 到达后立即复位。
    suppress_current_tool_intro = False
    # 提示词不能保证所有模型都在首个工具前输出正文。服务端只为整轮首个真实操作
    # 补一次简短确认，后续工具仍完全按模型原始叙述展示，避免每写一个文件都刷一句。
    has_emitted_round_intro = False
    wrote_files = initial_wrote_files
    truncated = False
    build_reuse_state = build_reuse_state or BuildCheckReuseState()
    pending: dict[str, tuple[str, dict, DBMessage]] = dict(initial_pending or {})
    # 「同批含 check_build」时被抢先补发过 file_write 的 tool_call_id 集合 ——
    # tools 节点回收结果时据此跳过重发，避免同一文件的 file_write 发两遍（见 _early_file_write）。
    early_written: set[str] = set(initial_early_written or ())
    # model 节点会先登记浏览器增强回报归属，ToolNode 完成服务端构建后才发预览 URL。
    # 客户端或任务中途断开时，用函数级 finally 撤销残留归属。
    armed_check_ids: set[str] = set()
    # 复用检查只在 LangGraph 内部回一条 ToolMessage 给模型，不落库、不发 SSE 工具卡；
    # 用户时间线继续保留上一次真实构建卡，避免看起来又自检了一遍。
    suppressed_check_ids: set[str] = set(initial_suppressed_check_ids or ())

    # ── 工具卡「流式提前亮」用的累积状态 ──
    announced_tools: set[str] = set()
    # 只有 messages 流里提前亮、但尚未等到完整 model update 的卡属于可丢弃草稿。
    # 已完成 model/tools 节点的卡绝不能放进这里，否则恢复时会误删真实执行记录。
    draft_tool_ids: set[str] = set()
    path_sent: set[str] = set()
    tool_chunk_args: dict[str, str] = {}
    tool_chunk_idx: dict[int, str] = {}
    tool_chunk_name: dict[str, str] = {}

    config = {"configurable": {"thread_id": thread_id}, "recursion_limit": RECURSION_LIMIT}

    def ensure_reasoning_id() -> str:
        """为当前模型调用分配稳定 id，增量帧与完成帧用它更新同一张卡。"""
        nonlocal reasoning_seq, active_reasoning_id
        if active_reasoning_id is None:
            reasoning_seq += 1
            active_reasoning_id = f"{thread_id}:reasoning:{reasoning_seq}"
        return active_reasoning_id

    def reset_active_reasoning() -> None:
        nonlocal active_reasoning_id, active_reasoning_text
        active_reasoning_id = None
        active_reasoning_text = ""

    def reasoning_delta(raw: str) -> str:
        """兼容厂商返回真正增量或「截至当前的累计文本」两种流形态。"""
        nonlocal active_reasoning_text
        if not raw or len(active_reasoning_text) >= REASONING_CONTENT_CAP:
            return ""
        if raw.startswith(active_reasoning_text):
            delta = raw[len(active_reasoning_text) :]
        elif active_reasoning_text.endswith(raw):
            delta = ""
        else:
            delta = raw
        remaining = REASONING_CONTENT_CAP - len(active_reasoning_text)
        delta = delta[:remaining]
        active_reasoning_text += delta
        return delta

    def visible_text_delta(raw: str) -> str:
        """缓存模型可见正文，兼容真正增量与累计文本两种流形态。

        此时尚不知道无工具候选会不会被 NoBluffMiddleware 打回，因此不能立即展示；
        等首个工具调用 chunk 出现后，工具调用本身即可证明这条消息不是嘴炮。
        """
        nonlocal active_visible_text
        if not raw:
            return ""
        if raw.startswith(active_visible_text):
            delta = raw[len(active_visible_text) :]
        elif active_visible_text.endswith(raw):
            delta = ""
        else:
            delta = raw
        active_visible_text += delta
        return delta

    def reset_active_visible_text() -> None:
        nonlocal active_visible_text, emitted_tool_intro
        active_visible_text = ""
        emitted_tool_intro = ""

    def fallback_tool_intro(tool_name: str) -> str:
        """模型首个工具调用没有正文时，给用户一个克制的开工反馈。"""
        if tool_name in {"list_files", "read_files"}:
            return "好的，我先看看现有项目结构，然后开始实现。"
        if tool_name in {"write_file", "edit_file"}:
            return "好的，我已经理解需求，现在开始实现。"
        if tool_name == "check_build":
            return "代码已经准备好，我来做一次构建检查。"
        return ""

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
        # 现在改成：正文 token 先缓存，首个工具调用 chunk 出现时即可确认这条消息不会
        # 被打回，于是先释放工具前开场，再亮工具卡；没有工具的普通回答仍等 updates
        # 确认或图自然收尾后才整段下发。推理字段则用 reasoning_delta 实时下发。
        # 若 NoBluffMiddleware 把这次候选打回，下一次 model 流开始时会发
        # reasoning_discard 删除旧临时卡，避免把被否决候选的思路留在时间线上。
        async for mode, chunk in _astream_with_model_recovery(
            agent,
            graph_input,
            config=config,
        ):
            if mode == "generation_retry":
                # 当前 model 没有完整 update，流式工具参数只是未执行草稿。精确通知前端
                # 删除这些 id，不能在活跃 SSE 中全量刷新 DB（会与恢复后的新事件竞态）。
                unfinished_id = active_reasoning_id or (
                    final_reasoning_payload.get("id")
                    if final_reasoning_payload
                    else None
                )
                if unfinished_id:
                    yield sse({"type": "reasoning_discard", "id": unfinished_id})
                discard_tool_ids = sorted(draft_tool_ids)
                final_assistant_text = ""
                final_reasoning_payload = None
                reset_active_reasoning()
                reset_active_visible_text()
                suppress_current_tool_intro = has_emitted_round_intro
                draft_tool_ids.clear()
                announced_tools.clear()
                path_sent.clear()
                tool_chunk_args.clear()
                tool_chunk_idx.clear()
                tool_chunk_name.clear()
                yield sse(
                    {
                        "type": "generation_retry",
                        "attempt": chunk["attempt"],
                        "max_attempts": chunk["max_attempts"],
                        "discard_tool_ids": discard_tool_ids,
                    }
                )
                continue

            # ── messages 模式：推理正文 + 工具参数都按 token 尽早下发 ──
            if mode == "messages":
                msg, meta = chunk
                if meta.get("langgraph_node") == "model":
                    # 上一次无工具候选若没有走到 END，而是又进入 model，说明它被
                    # NoBluffMiddleware 否决了；移除已经流给前端的临时思考卡。
                    if emit_reasoning and final_reasoning_payload is not None:
                        stale_id = final_reasoning_payload.get("id")
                        if stale_id:
                            yield sse({"type": "reasoning_discard", "id": stale_id})
                        final_reasoning_payload = None
                        final_assistant_text = ""

                    if emit_reasoning:
                        delta = reasoning_delta(reasoning_delta_text(msg))
                        if delta:
                            yield sse(
                                {
                                    "type": "reasoning_delta",
                                    "id": ensure_reasoning_id(),
                                    "text": delta,
                                }
                            )

                    # 先缓存可见正文；只有下面真正收到工具调用 chunk 后才允许展示，
                    # 从而同时满足“开工前先回应”和“不展示被打回的嘴炮”。
                    visible_text_delta(extract_text(msg))

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
                            if (
                                not emitted_tool_intro
                                and not suppress_current_tool_intro
                            ):
                                intro = active_visible_text
                                if not intro and not has_emitted_round_intro:
                                    intro = fallback_tool_intro(name)
                                emitted_tool_intro = intro
                                if emitted_tool_intro:
                                    has_emitted_round_intro = True
                                    yield sse(
                                        {
                                            "type": "message_delta",
                                            "text": emitted_tool_intro,
                                        }
                                    )
                                    await _save_message(
                                        db,
                                        db_lock,
                                        session_id,
                                        "assistant",
                                        emitted_tool_intro,
                                    )
                            # check_build 要等完整 model update 才能知道是否命中同轮幂等缓存；
                            # 先不亮卡，避免随后判定为复用时留下一张空的重复自检卡。
                            if name == "check_build":
                                continue
                            announced_tools.add(cid)
                            draft_tool_ids.add(cid)
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
                            if active_reasoning_id:
                                yield sse(
                                    {
                                        "type": "reasoning_discard",
                                        "id": active_reasoning_id,
                                    }
                                )
                                reset_active_reasoning()
                            final_reasoning_payload = None
                            reset_active_visible_text()
                            truncated = True
                            break

                        reasoning_payload = None
                        if emit_reasoning:
                            reasoning_payload = _reasoning_payload(
                                m,
                                active_reasoning_text,
                            )
                            if reasoning_payload is not None:
                                reasoning_payload["id"] = ensure_reasoning_id()
                        text = extract_text(m)
                        if m.tool_calls:
                            # 这一轮又调了工具,说明之前(若有)攒着没发的
                            # final_assistant_text 只是嘴炮重试前的半成品候选——
                            # 真调用工具证明它不是"这一轮的最终回复",作废丢弃,
                            # 避免收尾时把这段旧文字和这次真实工作的回复一起冒出来。
                            final_assistant_text = ""
                            if final_reasoning_payload and final_reasoning_payload.get(
                                "id"
                            ):
                                yield sse(
                                    {
                                        "type": "reasoning_discard",
                                        "id": final_reasoning_payload["id"],
                                    }
                                )
                            final_reasoning_payload = None
                            if reasoning_payload:
                                yield sse(reasoning_payload)
                                await _save_reasoning_message(
                                    db, db_lock, session_id, reasoning_payload
                                )
                            reset_active_reasoning()
                            if text:
                                print(f"[response] content={text} (同轮调用了工具)")
                                # 带 tool_calls 的消息不可能被 NoBluffMiddleware 判定为嘴炮
                                # （见 middleware.aafter_model 第一行判断),此刻就能放心下发。
                                # 流式阶段若已经在首个工具 chunk 前释放过开场文字，这里
                                # 不得重复展示或落库；未提供流式正文的厂商仍走原有整段下发。
                                if (
                                    not emitted_tool_intro
                                    and not suppress_current_tool_intro
                                ):
                                    yield sse({"type": "message_delta", "text": text})
                                    await _save_message(
                                        db,
                                        db_lock,
                                        session_id,
                                        "assistant",
                                        text,
                                    )
                            # 极少数 provider 会无视 parallel_tool_calls=False。若同一批给出
                            # 多个 check_build 共用单并发 Worker，不能并发构建；
                            # 只执行第一项，后续项仍 arm 后立即回一条可读错误，避免它们各等
                            # 90 秒或让 scalar preview 请求互相覆盖。
                            primary_check_id = next(
                                (
                                    call["id"]
                                    for call in m.tool_calls
                                    if call["name"] == "check_build"
                                ),
                                None,
                            )
                            has_same_batch_write = any(
                                call["name"] in ("write_file", "edit_file")
                                for call in m.tool_calls
                            )
                            # 画布切换必须先于同一批里的 preview_refresh：无论 provider
                            # 把工具按什么顺序返回，后续 iframe 重载和截图都要使用目标 viewport。
                            for call in m.tool_calls:
                                device_event = preview_device_event(call)
                                if device_event is not None:
                                    yield sse(device_event)
                            for tc in m.tool_calls:
                                if tc["name"] == "ask_user":
                                    tc["args"]["questions"] = normalize_ask_user_questions(
                                        tc["args"].get("questions")
                                    )
                                print(f"[tool_call] name={tc['name']} args={list(tc['args'].keys())}")
                                if tc["name"] == "check_build":
                                    # ── 竞态防护：同批若还有 write_file/edit_file，它们真正的 file_write
                                    # 事件会被 tools 节点屏障拖到 check_build 之后才发（见 _early_file_write
                                    # 的详细说明）。这里在服务端构建前用这些工具自己的 args
                                    # 把 file_write 抢先补发出去并登记 overlay，保证前后端都对应
                                    # 这一批的新内容，而不是改动前的旧文件。
                                    # early_written 记下已抢发过的 tool_call_id，tools 节点分支据此跳过重发。
                                    for other in m.tool_calls:
                                        if other["id"] == tc["id"] or other["id"] in early_written:
                                            continue
                                        if other["name"] not in ("write_file", "edit_file"):
                                            continue
                                        ev = await _early_file_write(db, db_lock, session_id, other)
                                        if ev is not None:
                                            build_reuse_state.set_file_overlay(
                                                tc["id"],
                                                ev["path"],
                                                ev["content"],
                                            )
                                            wrote_files = True
                                            early_written.add(other["id"])
                                            yield sse(ev)

                                    # ── 同轮幂等：可靠检查之后文件摘要完全相同，就不再触发浏览器。
                                    # 同批带写工具时 DB 可能尚未提交，无法安全比较最终摘要，必须
                                    # 强制真实检查；整批 tools 完成后再由 finish_check 记录新摘要。
                                    fingerprint = None
                                    if not has_same_batch_write:
                                        try:
                                            fingerprint = await project_files_fingerprint(
                                                db,
                                                session_id,
                                                db_lock,
                                            )
                                        except Exception as exc:
                                            print(
                                                "[check_build] 文件摘要计算失败，本次执行真实检查: "
                                                f"{type(exc).__name__}: {exc}"
                                            )
                                    reuse = build_reuse_state.prepare_check(
                                        tc["id"],
                                        fingerprint,
                                        force_fresh=has_same_batch_write,
                                    )
                                    if reuse:
                                        suppressed_check_ids.add(tc["id"])
                                        print(
                                            "[check_build] 文件未变化，跳过重复构建 "
                                            f"id={tc['id']}"
                                        )
                                        # ToolNode 仍会执行并把缓存结论回给模型，维持
                                        # AIMessage ↔ ToolMessage 配对；只是不给用户再画一张卡。
                                        continue

                                    if tc["id"] != primary_check_id:
                                        # 同一 AIMessage 里额外出现的 check_build 不占用单并发
                                        # Worker，只让工具闭包返回一条合成结果给模型，也不生成
                                        # 第二张用户可见工具卡。
                                        suppressed_check_ids.add(tc["id"])
                                        build_reuse_state.mark_duplicate(tc["id"])
                                        continue

                                    # check_build 在流式参数阶段被刻意延后到这里才亮卡；此时已
                                    # 确认它确实会触发一次新的构建。
                                    announced_tools.add(tc["id"])
                                    yield sse(
                                        {
                                            "type": "tool_call",
                                            "name": tc["name"],
                                            "args": tc["args"],
                                            "id": tc["id"],
                                        }
                                    )
                                    # 浏览器预览和截图仍是在线时的增强能力。先登记回报归属，
                                    # 但必须等服务端构建完成后再下发 capability URL；此处不能
                                    # 让浏览器提前发起第二次构建去争抢单并发 Worker。
                                    build_store.arm(session_id, tc["id"])
                                    armed_check_ids.add(tc["id"])
                                else:
                                    yield sse(
                                        {
                                            "type": "tool_call",
                                            "name": tc["name"],
                                            "args": tc["args"],
                                            "id": tc["id"],
                                        }
                                    )
                                # ask_user 不需要类似的"武装会合点"：它的问题内容已经通过上面
                                # 这条 tool_call 事件的 args 字段（questions）下发给前端了，
                                # 等待 / 恢复完全交给 interrupt() + checkpointer（见上面
                                # __interrupt__ 分支），不需要在这里额外记录任何东西。
                                tool_msg = await _save_message(
                                    db, db_lock, session_id, "assistant", "", kind="tool",
                                    tool_name=tc["name"],
                                    tool_args=_stored_tool_args(tc["args"], tc["id"]),
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
                            reset_active_reasoning()
                            print(f"[最终回复候选] content={text}")
                        reset_active_visible_text()
                        # 完整 model update 已进入 checkpoint；这些调用不再是流式草稿，
                        # 后续即使别的节点报错也必须保留工具卡。
                        draft_tool_ids.clear()
                        suppress_current_tool_intro = False
                    if truncated:
                        break

                elif node_name == "tools":
                    for tm in node_messages:
                        # tools 节点通常只产 ToolMessage；显式收窄后再访问 tool_call_id /
                        # artifact，避免 provider 或中间件附带其它消息类型时误处理。
                        if not isinstance(tm, ToolMessage):
                            continue
                        if tm.tool_call_id in suppressed_check_ids:
                            build_reuse_state.finish_check(
                                tm.tool_call_id,
                                None,
                                "",
                            )
                            print(
                                "[check_build] 已把复用结论回给模型，"
                                f"不生成重复工具卡 id={tm.tool_call_id}"
                            )
                            continue
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
                        screenshot_ref = None
                        screenshot = screenshot_from_artifact(tm.artifact)
                        if screenshot is not None:
                            screenshot_ref = screenshot[1]
                            # Message.images 已有持久化与刷新回显能力；这里只保存鉴权 URL，
                            # 不把 data URL 再复制一份进主数据库。完整 ref 放 tool_args，
                            # 让刷新后的历史卡仍能显示画布、尺寸和路由。
                            tool_msg.images = [str(screenshot_ref["url"])]
                        if name == "check_build":
                            # 正常路径的工具闭包已经登记分类；断线续跑若换了闭包，则从
                            # checkpointer 里的 ToolMessage 保守恢复，避免丢掉可靠结果。
                            if not build_reuse_state.has_result_classification(
                                tm.tool_call_id
                            ):
                                build_reuse_state.note_fresh_result(
                                    tm.tool_call_id,
                                    cacheable=_restored_check_cacheability(
                                        capped,
                                        has_screenshot=screenshot is not None,
                                    ),
                                )
                            fingerprint = None
                            try:
                                fingerprint = await project_files_fingerprint(
                                    db,
                                    session_id,
                                    db_lock,
                                )
                            except Exception as exc:
                                print(
                                    "[check_build] 结果摘要计算失败，不缓存本次检查: "
                                    f"{type(exc).__name__}: {exc}"
                                )
                            cache_action = build_reuse_state.finish_check(
                                tm.tool_call_id,
                                fingerprint,
                                capped,
                            )
                            # ask_user / 断线续跑会重建工具闭包；把本轮缓存动作与摘要放在
                            # 已有工具行里即可恢复，不增加表结构，也绝不跨用户消息复用。
                            tool_msg.tool_args = {
                                **(args or {}),
                                "_tool_call_id": tm.tool_call_id,
                                **(
                                    {"_screenshot": screenshot_ref}
                                    if screenshot_ref is not None
                                    else {}
                                ),
                                "_build_cache": cache_action,
                                **(
                                    {"_build_fingerprint": fingerprint}
                                    if cache_action == "store" and fingerprint
                                    else {}
                                ),
                            }
                        async with db_lock:
                            await db.commit()
                        result_event = {
                            "type": "tool_result",
                            "id": tm.tool_call_id,
                            "result": capped,
                        }
                        if screenshot_ref is not None:
                            result_event["screenshot"] = screenshot_ref
                        yield sse(result_event)

                        if name == "check_build":
                            preview_event = sandbox_preview_event(
                                tm.tool_call_id,
                                tm.artifact,
                            )
                            if preview_event is not None:
                                yield sse(preview_event)

                        if name == "check_build":
                            print(f"[check_build] {tool_result}")

                        # write_file / edit_file：若这条已在 check_build 同批里被 _early_file_write
                        # 抢先补发过（id 在 early_written 里），这里就只落 tool_result、不再重发
                        # file_write，避免前端收到同一文件两遍。
                        elif name == "write_file":
                            written_path = successful_file_tool_path(
                                name, args, tool_result
                            )
                            content = (
                                args.get("content")
                                if isinstance(args, dict)
                                else None
                            )
                            if written_path is not None and isinstance(content, str):
                                wrote_files = True
                            if (
                                written_path is not None
                                and isinstance(content, str)
                                and tm.tool_call_id not in early_written
                            ):
                                yield sse({
                                    "type": "file_write",
                                    "path": written_path,
                                    "content": content,
                                })
                        elif name == "edit_file":
                            edited_path = successful_file_tool_path(
                                name, args, tool_result
                            )
                            if (
                                edited_path is not None
                                and tm.tool_call_id in early_written
                            ):
                                wrote_files = True
                            elif edited_path is not None:
                                async with db_lock:
                                    res = await db.execute(
                                        select(File.content).where(
                                            File.session_id == session_id,
                                            File.path == edited_path,
                                        )
                                    )
                                    content = res.scalar_one_or_none()
                                if content is not None:
                                    wrote_files = True
                                    yield sse({
                                        "type": "file_write",
                                        "path": edited_path,
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
            names = await name_next_generated_version(
                db,
                session_id=session_id,
                model=model,
                user_request=summary_text,
                assistant_result=final_assistant_text,
            )
            version = await snapshot_current_files(
                db,
                session_id,
                summary=names.version_name,
                project_title=names.project_name,
            )
            if version is not None:
                event = {
                    "type": "version",
                    "version_id": version.id,
                    "seq": version.seq,
                    "name": version.summary,
                }
                if version.seq == 1 and names.project_name:
                    event["project_name"] = names.project_name
                yield sse(event)

        if not truncated:
            await _charge_user(db, user_id, model, model_cost)

        # 这一轮真正跑完(没有 pending interrupt),清掉这次的 checkpoint。
        await _cleanup_thread(thread_id)
        yield sse({"type": "done"})

    except GraphRecursionError:
        unfinished_id = active_reasoning_id or (
            final_reasoning_payload.get("id") if final_reasoning_payload else None
        )
        if unfinished_id:
            yield sse({"type": "reasoning_discard", "id": unfinished_id})
        yield sse({
            "type": "error",
            "message": "已达最大轮次,自动停止以防死循环。",
        })
        await _cleanup_thread(thread_id)
        yield sse({"type": "done"})
    except Exception as e:
        print(
            f"[生成失败] {type(e).__name__}: {e}",
            flush=True,
        )
        unfinished_id = active_reasoning_id or (
            final_reasoning_payload.get("id") if final_reasoning_payload else None
        )
        if unfinished_id:
            yield sse({"type": "reasoning_discard", "id": unfinished_id})
        is_model_stream_error = _is_retryable_model_stream_error(e)
        message = (
            "模型上游连接中断，自动恢复后仍未成功。请点击“重新生成”再试。"
            if is_model_stream_error
            else str(e)
        )
        yield sse(
            {
                "type": "error",
                "message": message,
                # 第二次中断前也可能已流出一张未执行的工具草稿；前端精确删除对应 id
                # 再画错误卡，不能把虚线 loading 永久留在时间线上。
                **(
                    {
                        "reset_draft": True,
                        "discard_tool_ids": sorted(draft_tool_ids),
                    }
                    if is_model_stream_error
                    else {}
                ),
            }
        )
        await _cleanup_thread(thread_id)
        yield sse({"type": "done"})
    finally:
        for check_id in armed_check_ids:
            build_store.disarm(session_id, check_id)


async def agent_loop(
    req: ChatRequest,
    db: AsyncSession,
    user_id: str,
    *,
    model_cost: int | None = None,
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
        try:
            prepared = await _prepare_retry(req, db)
        except Exception as e:
            # retry 的 checkpoint 清理是正确性的前置条件，不能像正常收尾那样吞错继续；
            # 否则会再次从 ask_user 暂停点续跑。转成完整 SSE 错误帧，避免前端只看到断流。
            print(f"[重新生成准备失败] {type(e).__name__}: {e}")
            yield sse({"type": "error", "message": "重新生成准备失败，请稍后重试。"})
            yield sse({"type": "done"})
            return
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
    build_reuse_state = BuildCheckReuseState()
    try:
        # /api/chat 会把额度校验时读取的倍率传进来；默认分支仅兼容内部直接调用。
        # 无论哪条路径，都必须在构造 agent 前固定本轮倍率。
        if model_cost is None:
            model_cost = models_by_id()[req.model]["cost"]
        agent = build_round_agent(
            db,
            req.session_id,
            req.model,
            db_lock,
            tree_note,
            thinking=req.thinking,
            build_reuse_state=build_reuse_state,
        )
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
        model_cost=model_cost,
        db=db,
        db_lock=db_lock,
        user_id=user_id,
        emit_reasoning=req.thinking is not False,
        build_reuse_state=build_reuse_state,
    ):
        yield event

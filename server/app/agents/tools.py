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
90s）；set_preview_device 只是通过 loop 下发 UI 事件，同样不碰 db；ask_user 也不碰 db，
但等待方式不同——它用 LangGraph 的 interrupt() 把整个调用暂停 + 图状态存进
checkpointer，直接结束这次请求，不占着一条长连接干等（详见 app.agents.loop 里
thread_id / checkpointer 的说明），所以这三个工具都不纳入 db_lock。
"""

import asyncio
import hashlib
import json
from dataclasses import dataclass, field
from typing import Annotated, Literal

from langchain.tools import ToolRuntime
from langchain_core.tools import tool
from langgraph.types import interrupt
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app import build_store
from app.models.file import File
from app.preview_screenshots import build_screenshot_artifact


class AskUserOption(BaseModel):
    """ask_user 的结构化选项。

    label 是提交给用户的短选项；description 只做补充说明。明确建模后，供应商收到的
    tool schema 不再是任意 dict，能显著减少模型自创字段造成的空白提问卡。
    """

    model_config = ConfigDict(extra="ignore")

    label: str = Field(min_length=1)
    description: str | None = None

    @model_validator(mode="before")
    @classmethod
    def recover_description_only_option(cls, value: object) -> object:
        """让部署前已经写进 checkpoint 的 description-only 参数仍可恢复执行。"""
        if not isinstance(value, dict):
            return value
        label = value.get("label")
        description = value.get("description")
        if (
            (not isinstance(label, str) or not label.strip())
            and isinstance(description, str)
            and description.strip()
        ):
            return {"label": description.strip()}
        return value


class AskUserQuestion(BaseModel):
    """一张 ask_user 问题卡。选项兼容旧版字符串与新版 label/description 对象。"""

    model_config = ConfigDict(extra="ignore")

    header: str | None = None
    question: str = Field(min_length=1)
    options: list[Annotated[str, Field(min_length=1)] | AskUserOption]
    multi: bool = False

    @model_validator(mode="after")
    def validate_option_count(self) -> "AskUserQuestion":
        lo, hi = (1, 6) if self.multi else (2, 5)
        if not (lo <= len(self.options) <= hi):
            kind = "多选" if self.multi else "单选"
            raise ValueError(f"{kind} options 需要 {lo}~{hi} 个")
        return self


def normalize_ask_user_questions(value: object) -> object:
    """兼容部分模型把选项正文放进 description、却漏掉 label 的调用参数。

    规范化发生在 loop 下发 SSE 和持久化之前，因此前端、数据库、checkpoint 看到的是
    同一份可渲染结构。其余畸形值原样保留，交给 Pydantic 工具 schema 拒绝并让模型重试。
    """

    if not isinstance(value, list):
        return value

    questions: list[object] = []
    for raw_question in value:
        if not isinstance(raw_question, dict):
            questions.append(raw_question)
            continue
        question = dict(raw_question)
        raw_options = question.get("options")
        if not isinstance(raw_options, list):
            questions.append(question)
            continue

        options: list[object] = []
        for raw_option in raw_options:
            if not isinstance(raw_option, dict):
                options.append(raw_option)
                continue
            option = dict(raw_option)
            label = option.get("label")
            description = option.get("description")
            if (
                (not isinstance(label, str) or not label.strip())
                and isinstance(description, str)
                and description.strip()
            ):
                # qwen 等模型偶尔只返回 description/description_en。中文 description
                # 就是用户应看到的完整选项；不要再作为副标题重复显示一遍。
                option = {"label": description.strip()}
            options.append(option)
        question["options"] = options
        questions.append(question)
    return questions


@dataclass
class BuildCheckReuseState:
    """同一轮 Agent 内的构建幂等状态。

    ``check_build`` 真正执行前，loop 已经要决定是否向浏览器发 ``preview_refresh``；
    因此判定状态必须由 loop 与工具闭包共享，不能只在工具内部做结果缓存。
    """

    _decisions: dict[str, str] = field(default_factory=dict)
    _cacheable_results: dict[str, bool | None] = field(default_factory=dict)
    _cached_fingerprint: str | None = None
    _cached_content: str | None = None

    def prepare_check(
        self,
        check_id: str,
        fingerprint: str | None,
        *,
        force_fresh: bool = False,
    ) -> bool:
        """登记一次检查；返回 True 表示可直接复用上次结果。"""
        reuse = bool(
            not force_fresh
            and fingerprint
            and self._cached_content
            and fingerprint == self._cached_fingerprint
        )
        self._decisions[check_id] = "reuse" if reuse else "fresh"
        return reuse

    def should_reuse(self, check_id: str) -> bool:
        return self._decisions.get(check_id) == "reuse"

    def has_decision(self, check_id: str) -> bool:
        return check_id in self._decisions

    def restore(self, fingerprint: str, content: str) -> None:
        """从同一 LangGraph 轮的持久化工具记录恢复可靠缓存。"""
        if fingerprint and content:
            self._cached_fingerprint = fingerprint
            self._cached_content = content

    def reused_content(self) -> str:
        previous = self._cached_content or "上一次检查结果仍然有效。"
        return (
            "本轮上次自检后未检测到文件变化，已跳过重复构建和截图，"
            "直接复用上一次结论：\n"
            f"{previous}\n"
            "请直接依据该结论继续处理；除非先实际修改文件，否则不要再次调用 check_build。"
        )

    def note_fresh_result(
        self,
        check_id: str,
        *,
        cacheable: bool | None,
    ) -> None:
        """由工具记录真实检查是否足够可靠，等 tools 节点结束后再绑定文件指纹。"""
        self._cacheable_results[check_id] = cacheable

    def has_result_classification(self, check_id: str) -> bool:
        return check_id in self._cacheable_results

    def finish_check(
        self,
        check_id: str,
        fingerprint: str | None,
        content: str,
    ) -> str:
        """在整批工具都完成后提交缓存，并返回持久化动作。"""
        decision = self._decisions.pop(check_id, None)
        cacheable = self._cacheable_results.pop(check_id, False)
        if decision == "reuse":
            return "reuse"
        if cacheable is None:
            # 同批额外 check_build 的合成错误不代表预览状态，不覆盖已有缓存。
            return "ignore"
        if cacheable and fingerprint:
            self._cached_fingerprint = fingerprint
            self._cached_content = content
            return "store"
        # 超时、取消或成功但没有可靠截图都属于瞬态不完整结果，允许下一次真实重试。
        self._cached_fingerprint = None
        self._cached_content = None
        return "clear"


async def project_files_fingerprint(
    db: AsyncSession,
    session_id: str,
    db_lock: asyncio.Lock,
) -> str:
    """对当前完整文件集做稳定摘要，识别真正的内容变化。

    不依赖工具调用次数或 SQLite 时间精度；写回相同内容、失败编辑、手动回滚都能得到
    与实际文件状态一致的判断。
    """
    async with db_lock:
        result = await db.execute(
            select(File.path, File.content)
            .where(File.session_id == session_id)
            .order_by(File.path.asc())
        )
        rows = list(result.all())

    digest = hashlib.sha256()
    for path, content in rows:
        for value in (path, content):
            encoded = value.encode("utf-8")
            digest.update(len(encoded).to_bytes(8, "big"))
            digest.update(encoded)
    return digest.hexdigest()


def build_tools(
    db: AsyncSession,
    session_id: str,
    db_lock: asyncio.Lock,
    build_reuse_state: BuildCheckReuseState | None = None,
) -> list:
    """构造一组绑定到指定 session 的工具。

    db_lock：agent_loop 传入的请求级 asyncio.Lock，与消费端共用，串行化所有 db 操作。
    """
    build_reuse_state = build_reuse_state or BuildCheckReuseState()

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

    @tool(response_format="content_and_artifact")
    async def check_build(runtime: ToolRuntime) -> tuple[str, dict | None]:
        """把刚写的改动应用到预览、构建一次，并返回构建/运行报错。

        写完一组完整、能渲染的改动后调用它：前端会把暂存文件同步进容器、跑一次
        `vite build`（也就是把这组改动「揭晓」给用户看），然后把构建结果回传回来。
        没有报错就说明构建通过、能正常跑。

        重要：write_file / edit_file 只是把文件「暂存」下来，并不会刷新预览 —— 这样
        用户才不会看到「组件写好了、配套样式还没写」的半成品。所以一组改动写完后，
        务必调一次 check_build 才会真正构建 + 揭晓，也才能拿到报错。

        典型用法：write_file 写完所有相关文件 → check_build → 有报错就修、再 check_build。
        如果本轮上一次检查后文件没有变化，不要再次调用；工具层会跳过重复构建和截图。
        """
        # 时序：本工具的 tool_call 一出现，agent_loop 就会先 build_store.arm() 架好会合点、
        # 再推 preview_refresh 信号给前端（工具闭包里没法 yield 事件，所以放在 loop 里做，
        # 见 app.agents.loop）。前端收到后同步文件 → vite build → iframe 重载渲染、收集运行时
        # 报错 → 把「编译 + 运行」两类结果一并 POST 回 /build-result，那个端点调
        # build_store.report 立旗唤醒下面这个 wait。
        #
        # 所以这里只需纯等一个结果：前端多快回、这里多快返回，不靠固定窗口猜。
        # timeout=90 只是「前端彻底失联（构建卡死/断线）」的兜底，正常情况远用不到。
        check_id = runtime.tool_call_id
        if not check_id:
            return "构建检查内部错误：缺少 tool_call_id，请重新检查。", None

        # 断线续跑不会重放 model 节点里的 prepare_check。此时用恢复出的同轮缓存与
        # 当前文件摘要补判一次；真实待构建请求已由 resume API 重新 arm。
        if not build_reuse_state.has_decision(check_id):
            try:
                fingerprint = await project_files_fingerprint(
                    db,
                    session_id,
                    db_lock,
                )
            except Exception as exc:
                print(
                    "[check_build] 续跑摘要计算失败，不能复用旧结果: "
                    f"{type(exc).__name__}: {exc}"
                )
                fingerprint = None
            build_reuse_state.prepare_check(check_id, fingerprint)

        if build_reuse_state.should_reuse(check_id):
            return build_reuse_state.reused_content(), None

        result = await build_store.wait(session_id, check_id, timeout=90.0)
        if result is None:
            build_reuse_state.note_fresh_result(check_id, cacheable=False)
            return (
                "构建超时：预览迟迟没有回报结果，可能构建卡住或预览断开，"
                "请提示用户检查预览。",
                None,
            )

        # 截图是附加能力：文件读取失败时只打印诊断，构建文本结果仍照常回给 Agent。
        artifact = None
        screenshot_id = result.get("screenshot_id")
        if screenshot_id:
            try:
                artifact = await build_screenshot_artifact(
                    session_id,
                    str(screenshot_id),
                )
            except Exception as exc:
                print(
                    "[check_build] 截图读取失败，本次仅返回构建结果: "
                    f"{type(exc).__name__}: {exc}"
                )

        # 同一批里额外出现的 check_build 是 loop 合成的内部结果，不代表真实预览状态。
        synthetic = bool(result.get("_synthetic"))
        device_label = "H5" if result.get("device") == "mobile" else "桌面"
        device_note = f"本次检查使用{device_label}画布；页面仍需兼容另一端。"
        if result.get("ok"):
            if artifact is not None:
                build_reuse_state.note_fresh_result(
                    check_id,
                    cacheable=None if synthetic else True,
                )
                return (
                    f"{device_note}编译与运行时检查通过；"
                    "这不代表视觉截图已经合格，附带截图仍需由支持视觉的模型严格审查。",
                    artifact,
                )
            build_reuse_state.note_fresh_result(check_id, cacheable=False)
            return (
                f"{device_note}编译与运行时检查通过，但本次没有取得可靠截图，"
                "视觉效果尚未验证。",
                None,
            )
        build_reuse_state.note_fresh_result(
            check_id,
            cacheable=None if synthetic else True,
        )
        errors = str(result.get("errors") or "").strip() or "（无详细错误信息）"
        if result.get("runtime"):
            # 编译过了、但 iframe 渲染时崩（如 undefined is not a function）
            return (
                f"{device_note}构建通过，但预览运行时报错，请定位并修复：\n{errors}",
                artifact,
            )
        return (
            f"{device_note}预览构建失败（编译没通过），请定位并修复：\n{errors}",
            artifact,
        )

    @tool
    async def set_preview_device(
        device: Literal["desktop", "mobile"],
        reason: str = "",
    ) -> str:
        """切换用户预览区的观察画布。

        新会话默认已经是桌面画布，普通网站、博客、后台等 PC 需求不要重复调用本工具。
        只有 App、小程序、移动 Web、H5 等明确移动优先的需求才传 ``mobile``；
        ``desktop`` 只在用户明确要求从 H5 切回桌面画布时使用。本工具用于真实切换，
        不是用来声明或确认当前设备方向。

        ``reason`` 用一句短话说明判断依据，供用户在工具卡里查看。设备方向不明确时
        不必为此追问，也不要反复设置；保留用户当前画布即可。无论观察哪种画布，
        生成代码都必须同时响应式兼容手机与桌面。
        """
        label = "H5" if device == "mobile" else "桌面"
        suffix = f"（{reason.strip()}）" if reason.strip() else ""
        return f"已切换到{label}画布{suffix}；页面仍需同时兼容桌面与移动端。"

    @tool
    async def ask_user(questions: list[AskUserQuestion]) -> str:
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
        payload = [
            question.model_dump(exclude_none=True)
            for question in questions
        ]
        # interrupt()：把图状态存进 checkpointer 后暂停，这次 astream() 调用到此结束
        # （HTTP 请求随之正常关闭）。resume 时从这里接着往下走，返回值就是
        # Command(resume=answer) 传入的 answer——见 app.agents.loop 的 __interrupt__
        # 处理分支 + app.api.ask_result 的恢复逻辑。注意：resume 会导致本工具函数
        # 从头重新执行一遍（LangGraph 的既定语义），上面的校验逻辑本身是幂等的纯校验，
        # 重跑一遍没问题。
        return interrupt({"questions": payload})

    return [
        write_file,
        edit_file,
        read_files,
        list_files,
        set_preview_device,
        check_build,
        ask_user,
    ]

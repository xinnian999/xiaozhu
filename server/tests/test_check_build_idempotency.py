import asyncio
import json
from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock, patch

from langchain_core.messages import AIMessage, ToolMessage

from app.agents.loop import (
    PendingToolRecovery,
    _consume,
    preview_device_event,
    reseed_pending_from_state,
    restore_round_build_reuse_state,
    sse,
)
from app.agents.tools import BuildCheckReuseState, build_tools
from app.api.resume import (
    ResumeStart,
    _claim_resume_thread,
    _release_resume_thread,
    _resume_stream as resume_stream,
)


_PASS_CONTENT = (
    "编译与运行时检查通过；"
    "这不代表视觉截图已经合格，附带截图仍需由支持视觉的模型严格审查。"
)
_ARTIFACT = {
    "screenshot": {
        "id": "shot-1",
        "ref": {
            "id": "shot-1",
            "url": "/api/sessions/session-1/preview-screenshots/shot-1",
            "width": 1130,
            "height": 703,
            "path": "/",
            "mime": "image/webp",
        },
    }
}


def _event(frame: str) -> dict:
    return json.loads(frame.removeprefix("data: ").strip())


def _tool_call(name: str, call_id: str, args: dict | None = None) -> dict:
    return {
        "name": name,
        "args": args or {},
        "id": call_id,
        "type": "tool_call",
    }


class _TwoChecksAgent:
    """按真实图节点顺序产出两次检查，中间可插入一次写文件。"""

    def __init__(
        self,
        state: BuildCheckReuseState,
        *,
        first_content: str = _PASS_CONTENT,
        first_artifact: dict | None = _ARTIFACT,
        first_cacheable: bool = True,
        write_between: bool = False,
    ):
        self.state = state
        self.first_content = first_content
        self.first_artifact = first_artifact
        self.first_cacheable = first_cacheable
        self.write_between = write_between

    async def astream(self, _graph_input, *, stream_mode, config):
        assert stream_mode == ["updates", "messages"]
        assert config["configurable"]["thread_id"] == "thread-1"

        yield (
            "updates",
            {
                "model": {
                    "messages": [
                        AIMessage(
                            content="",
                            tool_calls=[_tool_call("check_build", "check-1")],
                        )
                    ]
                }
            },
        )
        self.state.note_fresh_result(
            "check-1",
            cacheable=self.first_cacheable,
        )
        yield (
            "updates",
            {
                "tools": {
                    "messages": [
                        ToolMessage(
                            content=self.first_content,
                            tool_call_id="check-1",
                            artifact=self.first_artifact,
                        )
                    ]
                }
            },
        )

        if self.write_between:
            write_args = {"path": "src/App.tsx", "content": "export default 1"}
            yield (
                "updates",
                {
                    "model": {
                        "messages": [
                            AIMessage(
                                content="",
                                tool_calls=[
                                    _tool_call("write_file", "write-1", write_args)
                                ],
                            )
                        ]
                    }
                },
            )
            yield (
                "updates",
                {
                    "tools": {
                        "messages": [
                            ToolMessage(
                                content="已写入 src/App.tsx",
                                tool_call_id="write-1",
                            )
                        ]
                    }
                },
            )

        yield (
            "updates",
            {
                "model": {
                    "messages": [
                        AIMessage(
                            content="",
                            tool_calls=[_tool_call("check_build", "check-2")],
                        )
                    ]
                }
            },
        )
        if self.state.should_reuse("check-2"):
            second_content = self.state.reused_content()
            second_artifact = None
        else:
            self.state.note_fresh_result("check-2", cacheable=True)
            second_content = _PASS_CONTENT
            second_artifact = _ARTIFACT
        yield (
            "updates",
            {
                "tools": {
                    "messages": [
                        ToolMessage(
                            content=second_content,
                            tool_call_id="check-2",
                            artifact=second_artifact,
                        )
                    ]
                }
            },
        )
        yield (
            "updates",
            {"model": {"messages": [AIMessage(content="完成")]}},
        )


class _SameBatchChecksAgent:
    """模拟 provider 无视串行工具设置，在一个 AIMessage 里给出两次检查。"""

    def __init__(self, state: BuildCheckReuseState):
        self.state = state

    async def astream(self, _graph_input, *, stream_mode, config):
        assert stream_mode == ["updates", "messages"]
        assert config["configurable"]["thread_id"] == "thread-1"

        yield (
            "updates",
            {
                "model": {
                    "messages": [
                        AIMessage(
                            content="",
                            tool_calls=[
                                _tool_call("check_build", "check-1"),
                                _tool_call("check_build", "check-2"),
                            ],
                        )
                    ]
                }
            },
        )
        # 第一项代表真实浏览器回报；第二项代表 loop 预先塞进会合点的合成结果。
        self.state.note_fresh_result("check-1", cacheable=True)
        self.state.note_fresh_result("check-2", cacheable=None)
        yield (
            "updates",
            {
                "tools": {
                    "messages": [
                        ToolMessage(
                            content=_PASS_CONTENT,
                            tool_call_id="check-1",
                            artifact=_ARTIFACT,
                        ),
                        ToolMessage(
                            content=(
                                "预览构建失败（编译没通过），请定位并修复：\n"
                                "同一批工具调用里出现了多个 check_build；本次只执行第一项。"
                            ),
                            tool_call_id="check-2",
                        ),
                    ]
                }
            },
        )
        yield (
            "updates",
            {"model": {"messages": [AIMessage(content="完成")]}},
        )


class CheckBuildIdempotencyTests(IsolatedAsyncioTestCase):
    def test_preview_device_event_only_accepts_complete_valid_tool_call(self):
        self.assertEqual(
            preview_device_event(
                _tool_call(
                    "set_preview_device",
                    "device-1",
                    {"device": "mobile", "reason": "小程序"},
                )
            ),
            {
                "type": "preview_device",
                "device": "mobile",
                "id": "device-1",
            },
        )
        self.assertIsNone(
            preview_device_event(
                _tool_call("set_preview_device", "device-2", {})
            )
        )
        self.assertIsNone(
            preview_device_event(
                _tool_call("set_preview_device", "device-3", {"device": "tablet"})
            )
        )

    async def _run_agent(
        self,
        agent: _TwoChecksAgent,
        state: BuildCheckReuseState,
        *,
        fingerprints: str | list[str] = "same-files",
    ) -> tuple[list[dict], list]:
        db = SimpleNamespace(commit=AsyncMock())

        async def save_message(*_args, **_kwargs):
            return SimpleNamespace(text="", images=None)

        fingerprint = AsyncMock()
        if isinstance(fingerprints, list):
            fingerprint.side_effect = fingerprints
        else:
            fingerprint.return_value = fingerprints

        with (
            patch(
                "app.agents.loop.project_files_fingerprint",
                new=fingerprint,
            ),
            patch(
                "app.agents.loop._save_message",
                new=AsyncMock(side_effect=save_message),
            ),
            patch(
                "app.agents.loop._charge_user",
                new_callable=AsyncMock,
            ),
            patch(
                "app.agents.loop._cleanup_thread",
                new_callable=AsyncMock,
            ),
            patch(
                "app.agents.loop.snapshot_current_files",
                new=AsyncMock(return_value=None),
            ),
            patch(
                "app.agents.loop.name_next_generated_version",
                new=AsyncMock(
                    return_value=SimpleNamespace(
                        version_name="测试版本",
                        project_name=None,
                    )
                ),
            ),
            patch("app.agents.loop.build_store.arm") as arm,
            patch("app.agents.loop.build_store.disarm"),
            patch("app.agents.loop.build_store.report"),
        ):
            frames = [
                frame
                async for frame in _consume(
                    agent,
                    {"messages": []},
                    "thread-1",
                    session_id="session-1",
                    summary_text="测试重复自检",
                    model="test-model",
                    db=db,  # type: ignore[arg-type]
                    db_lock=asyncio.Lock(),
                    user_id="user-1",
                    build_reuse_state=state,
                )
            ]
            arm_calls = list(arm.call_args_list)

        return [_event(frame) for frame in frames], arm_calls

    async def test_same_model_message_only_shows_one_real_check(self):
        state = BuildCheckReuseState()
        events, arm_calls = await self._run_agent(
            _SameBatchChecksAgent(state),  # type: ignore[arg-type]
            state,
        )

        refreshes = [event for event in events if event["type"] == "preview_refresh"]
        check_cards = [
            event
            for event in events
            if event["type"] == "tool_call"
            and event["name"] == "check_build"
        ]
        check_results = [
            event
            for event in events
            if event["type"] == "tool_result"
            and event["id"].startswith("check-")
        ]
        self.assertEqual([event["id"] for event in refreshes], ["check-1"])
        self.assertEqual([event["id"] for event in check_cards], ["check-1"])
        self.assertEqual([event["id"] for event in check_results], ["check-1"])
        # 第二项只使用内部会合点即时返回，不会触发第二次浏览器构建。
        self.assertEqual(len(arm_calls), 2)

    async def test_duplicate_check_without_write_skips_second_refresh(self):
        state = BuildCheckReuseState()
        events, arm_calls = await self._run_agent(
            _TwoChecksAgent(state),
            state,
        )

        refreshes = [event for event in events if event["type"] == "preview_refresh"]
        check_cards = [
            event
            for event in events
            if event["type"] == "tool_call"
            and event["name"] == "check_build"
        ]
        check_results = [
            event
            for event in events
            if event["type"] == "tool_result"
            and event["id"].startswith("check-")
        ]
        self.assertEqual([event["id"] for event in refreshes], ["check-1"])
        self.assertEqual([event["id"] for event in check_cards], ["check-1"])
        self.assertEqual([event["id"] for event in check_results], ["check-1"])
        self.assertEqual(len(arm_calls), 1)

    async def test_changed_files_allow_second_real_check(self):
        state = BuildCheckReuseState()
        events, arm_calls = await self._run_agent(
            _TwoChecksAgent(state, write_between=True),
            state,
            fingerprints=["before", "before", "after", "after"],
        )

        refreshes = [event for event in events if event["type"] == "preview_refresh"]
        self.assertEqual(
            [event["id"] for event in refreshes],
            ["check-1", "check-2"],
        )
        self.assertEqual(len(arm_calls), 2)

    async def test_writing_same_content_keeps_previous_check_reusable(self):
        state = BuildCheckReuseState()
        events, arm_calls = await self._run_agent(
            _TwoChecksAgent(state, write_between=True),
            state,
            fingerprints="same-files",
        )

        refreshes = [event for event in events if event["type"] == "preview_refresh"]
        self.assertEqual([event["id"] for event in refreshes], ["check-1"])
        self.assertEqual(len(arm_calls), 1)

    async def test_deterministic_failure_is_reused_without_write(self):
        state = BuildCheckReuseState()
        events, arm_calls = await self._run_agent(
            _TwoChecksAgent(
                state,
                first_content="预览构建失败（编译没通过）：语法错误",
                first_artifact=None,
                first_cacheable=True,
            ),
            state,
        )

        refreshes = [event for event in events if event["type"] == "preview_refresh"]
        self.assertEqual([event["id"] for event in refreshes], ["check-1"])
        self.assertEqual(len(arm_calls), 1)

    async def test_transient_incomplete_result_allows_retry(self):
        for first_content in (
            "构建超时：预览迟迟没有回报结果",
            "编译与运行时检查通过，但本次没有取得可靠截图",
        ):
            with self.subTest(first_content=first_content):
                state = BuildCheckReuseState()
                events, arm_calls = await self._run_agent(
                    _TwoChecksAgent(
                        state,
                        first_content=first_content,
                        first_artifact=None,
                        first_cacheable=False,
                    ),
                    state,
                )
                refreshes = [
                    event
                    for event in events
                    if event["type"] == "preview_refresh"
                ]
                self.assertEqual(
                    [event["id"] for event in refreshes],
                    ["check-1", "check-2"],
                )
                self.assertEqual(len(arm_calls), 2)

    async def test_tool_returns_cached_conclusion_without_waiting(self):
        state = BuildCheckReuseState()
        state.prepare_check("check-1", "same-files")
        state.note_fresh_result("check-1", cacheable=True)
        state.finish_check("check-1", "same-files", _PASS_CONTENT)
        self.assertTrue(state.prepare_check("check-2", "same-files"))

        tools = build_tools(
            AsyncMock(),  # type: ignore[arg-type]
            "session-1",
            asyncio.Lock(),
            build_reuse_state=state,
        )
        check_build = next(tool for tool in tools if tool.name == "check_build")
        with patch(
            "app.agents.tools.build_store.wait",
            new_callable=AsyncMock,
        ) as wait:
            content, artifact = await check_build.coroutine(
                SimpleNamespace(tool_call_id="check-2")
            )

        wait.assert_not_awaited()
        self.assertIn("已跳过重复构建和截图", content)
        self.assertIn(_PASS_CONTENT, content)
        self.assertIsNone(artifact)

    async def test_tool_rechecks_restored_cache_when_model_event_is_not_replayed(self):
        state = BuildCheckReuseState()
        state.restore("same-files", _PASS_CONTENT)
        tools = build_tools(
            AsyncMock(),  # type: ignore[arg-type]
            "session-1",
            asyncio.Lock(),
            build_reuse_state=state,
        )
        check_build = next(tool for tool in tools if tool.name == "check_build")

        with (
            patch(
                "app.agents.tools.project_files_fingerprint",
                new=AsyncMock(return_value="same-files"),
            ),
            patch(
                "app.agents.tools.build_store.wait",
                new_callable=AsyncMock,
            ) as wait,
        ):
            content, artifact = await check_build.coroutine(
                SimpleNamespace(tool_call_id="resumed-check")
            )

        wait.assert_not_awaited()
        self.assertIn("已跳过重复构建和截图", content)
        self.assertIsNone(artifact)

    async def test_tool_only_caches_complete_or_deterministic_results(self):
        cases = [
            (
                {"ok": True, "screenshot_id": "shot-1"},
                _ARTIFACT,
                True,
            ),
            (
                {"ok": False, "errors": "语法错误", "runtime": False},
                None,
                True,
            ),
            (
                {"ok": True},
                None,
                False,
            ),
            (
                {
                    "ok": False,
                    "errors": "预览页面加载超时",
                    "runtime": False,
                    "infrastructure": True,
                },
                None,
                False,
            ),
            (
                None,
                None,
                False,
            ),
        ]
        for result, artifact, expected_reuse in cases:
            with self.subTest(result=result):
                state = BuildCheckReuseState()
                state.prepare_check("check-1", "same-files")
                tools = build_tools(
                    AsyncMock(),  # type: ignore[arg-type]
                    "session-1",
                    asyncio.Lock(),
                    build_reuse_state=state,
                )
                check_build = next(
                    tool for tool in tools if tool.name == "check_build"
                )
                with (
                    patch(
                        "app.agents.tools.build_store.wait",
                        new=AsyncMock(return_value=result),
                    ),
                    patch(
                        "app.agents.tools.build_screenshot_artifact",
                        new=AsyncMock(return_value=artifact),
                    ),
                ):
                    content, _ = await check_build.coroutine(
                        SimpleNamespace(tool_call_id="check-1")
                    )

                state.finish_check("check-1", "same-files", content)
                self.assertEqual(
                    state.prepare_check("check-2", "same-files"),
                    expected_reuse,
                )

    async def test_tool_does_not_present_infrastructure_failure_as_code_error(self):
        state = BuildCheckReuseState()
        state.prepare_check("check-1", "same-files")
        tools = build_tools(
            AsyncMock(),  # type: ignore[arg-type]
            "session-1",
            asyncio.Lock(),
            build_reuse_state=state,
        )
        check_build = next(tool for tool in tools if tool.name == "check_build")

        with patch(
            "app.agents.tools.build_store.wait",
            new=AsyncMock(
                return_value={
                    "ok": False,
                    "errors": "预览页面加载超时",
                    "runtime": False,
                    "infrastructure": True,
                }
            ),
        ):
            content, artifact = await check_build.coroutine(
                SimpleNamespace(tool_call_id="check-1")
            )

        self.assertIn("预览基础设施未能完成验收", content)
        self.assertIn("不要据此修改或简化业务代码", content)
        self.assertNotIn("请定位并修复", content)
        self.assertIsNone(artifact)


class BuildCheckRestoreTests(IsolatedAsyncioTestCase):
    @staticmethod
    def _db_with_rows(rows: list[SimpleNamespace]):
        result = SimpleNamespace(
            scalars=lambda: SimpleNamespace(all=lambda: rows),
        )
        return SimpleNamespace(execute=AsyncMock(return_value=result))

    async def test_restore_uses_latest_reliable_result_in_same_round(self):
        state = BuildCheckReuseState()
        db = self._db_with_rows(
            [
                SimpleNamespace(
                    tool_args={"_build_cache": "reuse"},
                    text="内部复用记录",
                ),
                SimpleNamespace(
                    tool_args={
                        "_build_cache": "store",
                        "_build_fingerprint": "same-files",
                    },
                    text=_PASS_CONTENT,
                ),
            ]
        )

        restored = await restore_round_build_reuse_state(
            db,  # type: ignore[arg-type]
            "session-1",
            "session-1:42",
            asyncio.Lock(),
            state,
        )

        self.assertTrue(restored)
        self.assertTrue(state.prepare_check("next-check", "same-files"))

    async def test_incomplete_latest_result_blocks_older_cache(self):
        state = BuildCheckReuseState()
        db = self._db_with_rows(
            [
                SimpleNamespace(
                    tool_args={"_build_cache": "clear"},
                    text="构建超时",
                ),
                SimpleNamespace(
                    tool_args={
                        "_build_cache": "store",
                        "_build_fingerprint": "same-files",
                    },
                    text=_PASS_CONTENT,
                ),
            ]
        )

        restored = await restore_round_build_reuse_state(
            db,  # type: ignore[arg-type]
            "session-1",
            "session-1:42",
            asyncio.Lock(),
            state,
        )

        self.assertFalse(restored)
        self.assertFalse(state.prepare_check("next-check", "same-files"))


class PendingToolRecoveryTests(IsolatedAsyncioTestCase):
    @staticmethod
    def _empty_db():
        query_result = SimpleNamespace(
            scalars=lambda: SimpleNamespace(all=lambda: []),
        )
        added: list = []
        db = SimpleNamespace(
            execute=AsyncMock(return_value=query_result),
            add=added.append,
            commit=AsyncMock(),
        )
        return db, added

    async def test_missing_check_row_is_rebuilt_from_checkpoint(self):
        db, added = self._empty_db()
        graph_state = SimpleNamespace(
            values={
                "messages": [
                    AIMessage(
                        content="",
                        tool_calls=[_tool_call("check_build", "check-1")],
                    )
                ]
            }
        )
        reuse_state = BuildCheckReuseState()

        with patch(
            "app.agents.loop.project_files_fingerprint",
            new=AsyncMock(return_value="current-files"),
        ):
            recovery = await reseed_pending_from_state(
                db,  # type: ignore[arg-type]
                "session-1",
                "session-1:42",
                graph_state,
                asyncio.Lock(),
                reuse_state,
            )

        self.assertEqual(set(recovery.pending), {"check-1"})
        self.assertEqual(recovery.primary_check_ids, {"check-1"})
        self.assertEqual(len(added), 1)
        self.assertEqual(added[0].tool_args["_tool_call_id"], "check-1")

    async def test_missing_duplicate_row_stays_hidden_after_resume(self):
        db, added = self._empty_db()
        graph_state = SimpleNamespace(
            values={
                "messages": [
                    AIMessage(
                        content="",
                        tool_calls=[_tool_call("check_build", "check-2")],
                    )
                ]
            }
        )
        reuse_state = BuildCheckReuseState()
        reuse_state.restore("same-files", _PASS_CONTENT)

        with patch(
            "app.agents.loop.project_files_fingerprint",
            new=AsyncMock(return_value="same-files"),
        ):
            recovery = await reseed_pending_from_state(
                db,  # type: ignore[arg-type]
                "session-1",
                "session-1:42",
                graph_state,
                asyncio.Lock(),
                reuse_state,
            )

        self.assertEqual(recovery.pending, {})
        self.assertEqual(recovery.primary_check_ids, set())
        self.assertEqual(recovery.suppressed_check_ids, {"check-2"})
        self.assertEqual(added, [])

    async def test_same_batch_write_and_secondary_are_reconstructed(self):
        db, added = self._empty_db()
        calls = [
            _tool_call(
                "write_file",
                "write-1",
                {"path": "src/App.tsx", "content": "export default 1"},
            ),
            _tool_call("check_build", "check-1"),
            _tool_call("check_build", "check-2"),
        ]
        graph_state = SimpleNamespace(
            values={"messages": [AIMessage(content="", tool_calls=calls)]}
        )

        recovery = await reseed_pending_from_state(
            db,  # type: ignore[arg-type]
            "session-1",
            "session-1:42",
            graph_state,
            asyncio.Lock(),
            BuildCheckReuseState(),
        )

        self.assertEqual(set(recovery.pending), {"write-1", "check-1"})
        self.assertEqual(recovery.primary_check_ids, {"check-1"})
        self.assertEqual(recovery.suppressed_check_ids, {"check-2"})
        self.assertEqual(recovery.synthetic_check_ids, {"check-2"})
        self.assertEqual(len(added), 2)

    async def test_completed_checkpoint_result_backfills_loading_card(self):
        call = _tool_call("check_build", "check-1")
        graph_state = SimpleNamespace(
            values={
                "messages": [
                    AIMessage(content="", tool_calls=[call]),
                    ToolMessage(
                        content=_PASS_CONTENT,
                        tool_call_id="check-1",
                        artifact=_ARTIFACT,
                    ),
                ]
            }
        )
        row = SimpleNamespace(
            id=101,
            tool_name="check_build",
            tool_args={"_tool_call_id": "check-1"},
            text="",
            images=None,
        )
        query_result = SimpleNamespace(
            scalars=lambda: SimpleNamespace(all=lambda: [row]),
        )
        db = SimpleNamespace(
            execute=AsyncMock(return_value=query_result),
            add=lambda _row: None,
            commit=AsyncMock(),
        )
        reuse_state = BuildCheckReuseState()

        recovery = await reseed_pending_from_state(
            db,  # type: ignore[arg-type]
            "session-1",
            "session-1:42",
            graph_state,
            asyncio.Lock(),
            reuse_state,
        )

        self.assertEqual(recovery.pending, {})
        self.assertEqual([tc["id"] for tc in recovery.completed_calls], ["check-1"])
        self.assertEqual(
            [event["type"] for event in recovery.replay_events],
            ["tool_result"],
        )
        self.assertEqual(row.text, _PASS_CONTENT)
        self.assertEqual(row.images, [_ARTIFACT["screenshot"]["ref"]["url"]])
        self.assertEqual(row.tool_args["_build_cache"], "clear")
        self.assertNotIn("_build_fingerprint", row.tool_args)
        self.assertFalse(reuse_state.prepare_check("next-check", "current-files"))

    async def test_completed_write_replays_current_db_after_user_rollback(self):
        args = {
            "path": "src/App.tsx",
            "content": "断线前的旧写入",
        }
        call = _tool_call("write_file", "write-1", args)
        graph_state = SimpleNamespace(
            values={
                "messages": [
                    AIMessage(content="", tool_calls=[call]),
                    ToolMessage(
                        content="已写入 src/App.tsx",
                        tool_call_id="write-1",
                    ),
                ]
            }
        )
        row = SimpleNamespace(
            id=101,
            tool_name="write_file",
            tool_args={"_tool_call_id": "write-1", **args},
            text="",
            images=None,
        )
        tool_rows_result = SimpleNamespace(
            scalars=lambda: SimpleNamespace(all=lambda: [row]),
        )
        current_file_result = SimpleNamespace(
            scalar_one_or_none=lambda: "用户回滚后的当前内容",
        )
        db = SimpleNamespace(
            execute=AsyncMock(
                side_effect=[tool_rows_result, current_file_result]
            ),
            add=lambda _row: None,
            commit=AsyncMock(),
        )

        recovery = await reseed_pending_from_state(
            db,  # type: ignore[arg-type]
            "session-1",
            "session-1:42",
            graph_state,
            asyncio.Lock(),
            BuildCheckReuseState(),
        )

        self.assertTrue(recovery.wrote_files)
        self.assertEqual(
            recovery.replay_events[-1],
            {
                "type": "file_write",
                "path": "src/App.tsx",
                "content": "用户回滚后的当前内容",
            },
        )

    async def test_row_with_different_tool_call_id_is_never_reclaimed(self):
        graph_state = SimpleNamespace(
            values={
                "messages": [
                    AIMessage(
                        content="",
                        tool_calls=[_tool_call("check_build", "check-new")],
                    )
                ]
            }
        )
        stale = SimpleNamespace(
            id=100,
            tool_name="check_build",
            tool_args={"_tool_call_id": "check-old"},
            text="",
            images=None,
        )
        query_result = SimpleNamespace(
            scalars=lambda: SimpleNamespace(all=lambda: [stale]),
        )
        added: list = []
        db = SimpleNamespace(
            execute=AsyncMock(return_value=query_result),
            add=added.append,
            commit=AsyncMock(),
        )

        with patch(
            "app.agents.loop.project_files_fingerprint",
            new=AsyncMock(return_value="current-files"),
        ):
            recovery = await reseed_pending_from_state(
                db,  # type: ignore[arg-type]
                "session-1",
                "session-1:42",
                graph_state,
                asyncio.Lock(),
                BuildCheckReuseState(),
            )

        self.assertEqual(len(added), 1)
        self.assertIs(recovery.pending["check-new"][2], added[0])
        self.assertEqual(stale.tool_args["_tool_call_id"], "check-old")


class ResumeBuildCheckTests(IsolatedAsyncioTestCase):
    async def test_same_thread_cannot_be_resumed_twice_concurrently(self):
        thread_id = "session-concurrent:42"
        _release_resume_thread(thread_id)
        try:
            self.assertTrue(_claim_resume_thread(thread_id))
            self.assertFalse(_claim_resume_thread(thread_id))
        finally:
            _release_resume_thread(thread_id)
        self.assertTrue(_claim_resume_thread(thread_id))
        _release_resume_thread(thread_id)

    async def test_disconnect_after_rearm_disarms_pending_check(self):
        graph_state = SimpleNamespace(
            next=("tools",),
            interrupts=(),
            values={"messages": []},
        )
        agent = SimpleNamespace(
            aget_state=AsyncMock(return_value=graph_state),
        )
        tool_msg = SimpleNamespace(text="", tool_args={})
        db_result = SimpleNamespace(scalar_one_or_none=lambda: "继续任务")
        db = SimpleNamespace(execute=AsyncMock(return_value=db_result))

        with (
            patch("app.api.resume.default_model_id", return_value="test-model"),
            patch("app.api.resume.validate_thinking_option"),
            patch(
                "app.api.resume.latest_round_thread_id",
                new=AsyncMock(return_value="session-1:42"),
            ),
            patch(
                "app.api.resume._file_tree_note",
                new=AsyncMock(return_value=""),
            ),
            patch(
                "app.api.resume.restore_round_build_reuse_state",
                new=AsyncMock(return_value=False),
            ),
            patch("app.api.resume.build_round_agent", return_value=agent),
            patch(
                "app.api.resume.reseed_pending_from_state",
                new=AsyncMock(
                    return_value=PendingToolRecovery(
                        pending={
                            "check-1": ("check_build", {}, tool_msg),
                        },
                        open_calls=[_tool_call("check_build", "check-1")],
                        primary_check_ids={"check-1"},
                    ),
                ),
            ),
            patch("app.api.resume.build_store.arm") as arm,
            patch("app.api.resume.build_store.disarm") as disarm,
        ):
            stream = resume_stream(
                "session-1",
                ResumeStart(),
                db,  # type: ignore[arg-type]
                "user-1",
            )
            tool_call_event = _event(await anext(stream))
            self.assertEqual(
                tool_call_event,
                {
                    "type": "tool_call",
                    "name": "check_build",
                    "args": {},
                    "id": "check-1",
                },
            )
            first = _event(await anext(stream))
            self.assertEqual(
                first,
                {"type": "preview_refresh", "id": "check-1"},
            )
            # 模拟客户端刚收到刷新信号就再次断线；生成器关闭也必须清理会合点。
            await stream.aclose()

        arm.assert_called_once_with("session-1", "check-1")
        disarm.assert_called_once_with("session-1", "check-1")

    async def test_resume_applies_write_before_preview_and_hides_secondary(self):
        graph_state = SimpleNamespace(
            next=("tools",),
            interrupts=(),
            values={"messages": []},
        )
        agent = SimpleNamespace(
            aget_state=AsyncMock(return_value=graph_state),
        )
        write_args = {
            "path": "src/App.tsx",
            "content": "export default 1",
        }
        write_call = _tool_call("write_file", "write-1", write_args)
        primary_call = _tool_call("check_build", "check-1")
        secondary_call = _tool_call("check_build", "check-2")
        recovery = PendingToolRecovery(
            pending={
                "write-1": ("write_file", write_args, SimpleNamespace()),
                "check-1": ("check_build", {}, SimpleNamespace()),
            },
            open_calls=[write_call, primary_call, secondary_call],
            primary_check_ids={"check-1"},
            suppressed_check_ids={"check-2"},
            synthetic_check_ids={"check-2"},
        )
        db_result = SimpleNamespace(scalar_one_or_none=lambda: "继续任务")
        db = SimpleNamespace(execute=AsyncMock(return_value=db_result))

        with (
            patch("app.api.resume.default_model_id", return_value="test-model"),
            patch("app.api.resume.validate_thinking_option"),
            patch(
                "app.api.resume.latest_round_thread_id",
                new=AsyncMock(return_value="session-1:42"),
            ),
            patch(
                "app.api.resume._file_tree_note",
                new=AsyncMock(return_value=""),
            ),
            patch(
                "app.api.resume.restore_round_build_reuse_state",
                new=AsyncMock(return_value=False),
            ),
            patch("app.api.resume.build_round_agent", return_value=agent),
            patch(
                "app.api.resume.reseed_pending_from_state",
                new=AsyncMock(return_value=recovery),
            ),
            patch(
                "app.api.resume._early_file_write",
                new=AsyncMock(
                    return_value={
                        "type": "file_write",
                        "path": "src/App.tsx",
                        "content": "export default 1",
                    }
                ),
            ),
            patch("app.api.resume.build_store.arm") as arm,
            patch("app.api.resume.build_store.report") as report,
            patch("app.api.resume.build_store.disarm") as disarm,
        ):
            stream = resume_stream(
                "session-1",
                ResumeStart(),
                db,  # type: ignore[arg-type]
                "user-1",
            )
            events = [_event(await anext(stream)) for _ in range(4)]
            await stream.aclose()

        self.assertEqual(
            [event["id"] for event in events if event["type"] == "tool_call"],
            ["write-1", "check-1"],
        )
        event_types = [event["type"] for event in events]
        self.assertLess(
            event_types.index("file_write"),
            event_types.index("preview_refresh"),
        )
        self.assertEqual(events[-1]["id"], "check-1")
        self.assertEqual(
            [call.args for call in arm.call_args_list],
            [("session-1", "check-2"), ("session-1", "check-1")],
        )
        report.assert_called_once()
        self.assertEqual(report.call_args.args[:2], ("session-1", "check-2"))
        self.assertEqual(
            {call.args for call in disarm.call_args_list},
            {
                ("session-1", "check-1"),
                ("session-1", "check-2"),
            },
        )

    async def test_resume_replays_completed_result_without_new_preview(self):
        graph_state = SimpleNamespace(
            next=("model",),
            interrupts=(),
            values={"messages": []},
        )
        agent = SimpleNamespace(
            aget_state=AsyncMock(return_value=graph_state),
        )
        check_call = _tool_call("check_build", "check-1")
        replay_result = {
            "type": "tool_result",
            "id": "check-1",
            "result": _PASS_CONTENT,
            "screenshot": _ARTIFACT["screenshot"]["ref"],
        }
        recovery = PendingToolRecovery(
            completed_calls=[check_call],
            replay_events=[replay_result],
        )
        db_result = SimpleNamespace(scalar_one_or_none=lambda: "继续任务")
        db = SimpleNamespace(execute=AsyncMock(return_value=db_result))

        async def fake_consume(*_args, **_kwargs):
            yield sse({"type": "done"})

        with (
            patch("app.api.resume.default_model_id", return_value="test-model"),
            patch("app.api.resume.validate_thinking_option"),
            patch(
                "app.api.resume.latest_round_thread_id",
                new=AsyncMock(return_value="session-1:42"),
            ),
            patch(
                "app.api.resume._file_tree_note",
                new=AsyncMock(return_value=""),
            ),
            patch(
                "app.api.resume.restore_round_build_reuse_state",
                new=AsyncMock(return_value=False),
            ),
            patch("app.api.resume.build_round_agent", return_value=agent),
            patch(
                "app.api.resume.reseed_pending_from_state",
                new=AsyncMock(return_value=recovery),
            ),
            patch("app.api.resume._consume", new=fake_consume),
            patch("app.api.resume.build_store.arm") as arm,
        ):
            events = [
                _event(frame)
                async for frame in resume_stream(
                    "session-1",
                    ResumeStart(),
                    db,  # type: ignore[arg-type]
                    "user-1",
                )
            ]

        self.assertEqual(
            [event["type"] for event in events],
            ["tool_call", "tool_result", "done"],
        )
        self.assertEqual(events[1]["screenshot"]["id"], "shot-1")
        arm.assert_not_called()

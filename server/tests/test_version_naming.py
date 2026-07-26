from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock, patch

from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.agents.version_naming import (
    GeneratedVersionNames,
    name_next_generated_version,
    parse_generated_names,
)
from app.db import Base
from app.models.file import File
from app.models.message import Message
from app.models.session import Session
from app.models.user import User
from app.versioning import snapshot_current_files


class _ScalarResult:
    def __init__(self, value):
        self.value = value

    def scalar_one_or_none(self):
        return self.value


class VersionNamingParserTests(IsolatedAsyncioTestCase):
    def test_first_version_parses_project_and_version_names(self):
        names = parse_generated_names(
            '```json\n{"project_name":"极简博客","version_name":"v1：完成博客首页"}\n```',
            is_first_version=True,
        )
        self.assertEqual(
            names,
            GeneratedVersionNames(
                project_name="极简博客",
                version_name="完成博客首页",
            ),
        )

    def test_later_version_ignores_project_rename(self):
        names = parse_generated_names(
            '{"project_name":"不应覆盖","version_name":"增加文章搜索"}',
            is_first_version=False,
        )
        self.assertIsNone(names.project_name)
        self.assertEqual(names.version_name, "增加文章搜索")

    def test_rejects_product_description_as_version_name(self):
        with self.assertRaisesRegex(ValueError, "动作导向"):
            parse_generated_names(
                '{"project_name":"极简计算器","version_name":"深色界面四则运算"}',
                is_first_version=True,
            )

    async def test_model_failure_uses_stable_first_version_fallback(self):
        db = SimpleNamespace(execute=AsyncMock(return_value=_ScalarResult(None)))
        with patch(
            "app.agents.version_naming.build_llm",
            side_effect=RuntimeError("offline"),
        ):
            names = await name_next_generated_version(
                db,  # type: ignore[arg-type]
                session_id="session-1",
                model="test-model",
                user_request="写一个博客",
                assistant_result="博客首页已经完成",
            )

        self.assertEqual(names.version_name, "完成核心功能")
        self.assertIsNone(names.project_name)

    async def test_first_version_uses_selected_model_for_ai_names(self):
        db = SimpleNamespace(execute=AsyncMock(return_value=_ScalarResult(None)))
        llm = SimpleNamespace(
            ainvoke=AsyncMock(
                return_value=SimpleNamespace(
                    content='{"project_name":"技术拾光","version_name":"完成博客首页"}'
                )
            )
        )
        with (
            patch("app.agents.version_naming.build_llm", return_value=llm) as build_llm,
            patch(
                "app.agents.version_naming.models_by_id",
                return_value={"test-model": {"thinking_toggle": True}},
            ),
        ):
            names = await name_next_generated_version(
                db,  # type: ignore[arg-type]
                session_id="session-1",
                model="test-model",
                user_request="写一个技术博客",
                assistant_result="首页、文章列表和导航已经完成",
            )

        build_llm.assert_called_once_with("test-model", thinking=False)
        llm.ainvoke.assert_awaited_once()
        self.assertEqual(
            names,
            GeneratedVersionNames(
                project_name="技术拾光",
                version_name="完成博客首页",
            ),
        )


class VersionSnapshotNamingTests(IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with self.engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)

    async def asyncTearDown(self):
        await self.engine.dispose()

    async def test_v1_renames_project_and_every_card_persists_version_name(self):
        async with self.sessions() as db:
            user = User(
                email="naming@example.com",
                password_hash="hash",
                nickname="测试用户",
                avatar="seed",
            )
            db.add(user)
            await db.flush()
            session = Session(
                id="session-1",
                user_id=user.id,
                title="写一个博客",
            )
            db.add_all([
                session,
                File(
                    session_id=session.id,
                    path="src/App.tsx",
                    content="export default function App() { return null }",
                ),
            ])
            await db.commit()

            first = await snapshot_current_files(
                db,
                session.id,
                summary="完成博客首页",
                project_title="极简博客",
            )
            self.assertIsNotNone(first)
            self.assertEqual(session.title, "极简博客")

            second = await snapshot_current_files(
                db,
                session.id,
                summary="增加文章搜索",
                project_title="不应再次覆盖",
            )
            self.assertIsNotNone(second)
            self.assertEqual(session.title, "极简博客")

            rows = (
                await db.execute(
                    select(Message)
                    .where(Message.session_id == session.id, Message.kind == "version")
                    .order_by(Message.id)
                )
            ).scalars().all()
            self.assertEqual(
                [row.tool_args.get("name") for row in rows if row.tool_args],
                ["完成博客首页", "增加文章搜索"],
            )

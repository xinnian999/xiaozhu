"""版本接口时间序列化测试。"""

from datetime import datetime
from unittest import TestCase

from app.models.version import VersionRead


class VersionTimestampTest(TestCase):
    def test_naive_sqlite_timestamp_is_serialized_as_utc(self) -> None:
        """SQLite 的无时区时间必须带 UTC 偏移返回，避免前端误差八小时。"""
        version = VersionRead(
            id=1,
            session_id="session-1",
            seq=1,
            summary="首版",
            is_restore=False,
            created_at=datetime(2026, 7, 31, 3, 0, 0),
        )

        self.assertEqual(
            version.model_dump(mode="json")["created_at"],
            "2026-07-31T03:00:00+00:00",
        )

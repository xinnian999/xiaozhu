from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts.prepare_sandbox_storage import MARKER_NAME, prepare_storage
from scripts.restore_legacy_sandbox_storage import restore_legacy_storage


class SandboxStorageScriptTests(unittest.TestCase):
    def _make_storage(self, root: Path) -> tuple[Path, Path]:
        jobs = root / "jobs"
        previews = root / "previews"
        jobs.mkdir()
        previews.mkdir()
        return jobs, previews

    @patch("scripts.prepare_sandbox_storage.os.lchown")
    @patch("scripts.prepare_sandbox_storage.os.chown")
    def test_force_prepare_invalidates_marker_before_hardlink_failure(
        self,
        _chown,
        _lchown,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary_dir:
            root = Path(temporary_dir)
            _, previews = self._make_storage(root)
            (root / MARKER_NAME).write_text("10001:10001\n", encoding="ascii")
            source = previews / "source.txt"
            source.write_text("unsafe", encoding="utf-8")
            os.link(source, previews / "linked.txt")

            with self.assertRaisesRegex(RuntimeError, "硬链接"):
                prepare_storage(root, 10001, 10001, force=True)

            self.assertFalse((root / MARKER_NAME).exists())

    @patch("scripts.restore_legacy_sandbox_storage.os.lchown")
    @patch("scripts.restore_legacy_sandbox_storage.os.chown")
    def test_restore_invalidates_marker_before_hardlink_failure(
        self,
        _chown,
        _lchown,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary_dir:
            root = Path(temporary_dir)
            _, previews = self._make_storage(root)
            (root / MARKER_NAME).write_text("10001:10001\n", encoding="ascii")
            source = previews / "source.txt"
            source.write_text("unsafe", encoding="utf-8")
            os.link(source, previews / "linked.txt")

            with self.assertRaisesRegex(RuntimeError, "硬链接"):
                restore_legacy_storage(root)

            self.assertFalse((root / MARKER_NAME).exists())

    @patch("scripts.restore_legacy_sandbox_storage.os.lchown")
    @patch("scripts.restore_legacy_sandbox_storage.os.chown")
    def test_restore_clean_tree_uses_legacy_modes(self, _chown, _lchown) -> None:
        with tempfile.TemporaryDirectory() as temporary_dir:
            root = Path(temporary_dir)
            jobs, previews = self._make_storage(root)
            job_file = jobs / "source.tsx"
            preview_file = previews / "index.html"
            job_file.write_text("source", encoding="utf-8")
            preview_file.write_text("preview", encoding="utf-8")
            (root / MARKER_NAME).write_text("10001:10001\n", encoding="ascii")

            restore_legacy_storage(root)

            self.assertEqual(jobs.stat().st_mode & 0o777, 0o700)
            self.assertEqual(job_file.stat().st_mode & 0o777, 0o600)
            self.assertEqual(previews.stat().st_mode & 0o777, 0o755)
            self.assertEqual(preview_file.stat().st_mode & 0o777, 0o644)
            self.assertEqual(root.stat().st_mode & 0o777, 0o711)
            self.assertFalse((root / MARKER_NAME).exists())

    @patch("scripts.prepare_sandbox_storage.os.lchown")
    @patch("scripts.prepare_sandbox_storage.os.chown")
    def test_prepare_handles_tree_deeper_than_recursion_limit(
        self,
        _chown,
        _lchown,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary_dir:
            root = Path(temporary_dir)
            _, previews = self._make_storage(root)
            leaf = previews
            for index in range(120):
                leaf /= f"d{index}"
                leaf.mkdir()
            target = leaf / "index.html"
            target.write_text("deep", encoding="utf-8")

            original_limit = sys.getrecursionlimit()
            try:
                sys.setrecursionlimit(80)
                prepare_storage(root, 10001, 10001, force=True)
            finally:
                sys.setrecursionlimit(original_limit)

            self.assertEqual(target.stat().st_mode & 0o777, 0o644)
            self.assertTrue((root / MARKER_NAME).is_file())

    @patch("scripts.restore_legacy_sandbox_storage.os.lchown")
    @patch("scripts.restore_legacy_sandbox_storage.os.chown")
    def test_restore_handles_tree_deeper_than_recursion_limit(
        self,
        _chown,
        _lchown,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary_dir:
            root = Path(temporary_dir)
            _, previews = self._make_storage(root)
            leaf = previews
            for index in range(120):
                leaf /= f"d{index}"
                leaf.mkdir()
            target = leaf / "index.html"
            target.write_text("deep", encoding="utf-8")

            original_limit = sys.getrecursionlimit()
            try:
                sys.setrecursionlimit(80)
                restore_legacy_storage(root)
            finally:
                sys.setrecursionlimit(original_limit)

            self.assertEqual(target.stat().st_mode & 0o777, 0o644)


if __name__ == "__main__":
    unittest.main()

from unittest import TestCase, main

from app.api.build_result import BuildResult, _normalize_build_outcome


class NormalizeBuildOutcomeTests(TestCase):
    def test_legacy_layout_only_failure_is_ignored(self):
        ok, errors = _normalize_build_outcome(
            BuildResult(
                check_id="check-1",
                ok=False,
                errors=(
                    "[布局验收] 页面横向溢出 203px；请让内容在当前视口内换行或收缩。\n"
                    "[布局验收] fixed 元素横向越出可视区域。"
                ),
                visual=True,
                device="mobile",
            )
        )

        self.assertTrue(ok)
        self.assertEqual(errors, "")

    def test_runtime_error_survives_legacy_layout_filter(self):
        ok, errors = _normalize_build_outcome(
            BuildResult(
                check_id="check-2",
                ok=False,
                errors=(
                    "TypeError: Cannot read properties of undefined\n"
                    "[布局验收] fixed 元素横向越出可视区域。"
                ),
                runtime=True,
                visual=True,
            )
        )

        self.assertFalse(ok)
        self.assertEqual(errors, "TypeError: Cannot read properties of undefined")

    def test_current_compile_result_is_unchanged(self):
        ok, errors = _normalize_build_outcome(
            BuildResult(
                check_id="check-3",
                ok=False,
                errors="src/App.tsx: Unexpected token",
            )
        )

        self.assertFalse(ok)
        self.assertEqual(errors, "src/App.tsx: Unexpected token")


if __name__ == "__main__":
    main()

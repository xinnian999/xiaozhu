from unittest import TestCase

from app.agents.loop import successful_file_tool_path


class SuccessfulFileToolPathTests(TestCase):
    def test_missing_path_is_a_recoverable_tool_failure(self):
        self.assertIsNone(
            successful_file_tool_path(
                "edit_file",
                {"old_string": "旧", "new_string": "新"},
                "Error: path is required",
            )
        )

    def test_validation_error_does_not_count_as_a_write(self):
        self.assertIsNone(
            successful_file_tool_path(
                "write_file",
                {"path": "src/App.tsx", "content": "内容"},
                "Error: invalid arguments",
            )
        )

    def test_successful_edit_returns_validated_path(self):
        self.assertEqual(
            successful_file_tool_path(
                "edit_file",
                {"path": "src/App.tsx"},
                "已编辑 src/App.tsx",
            ),
            "src/App.tsx",
        )

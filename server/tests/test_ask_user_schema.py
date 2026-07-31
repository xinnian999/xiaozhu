"""ask_user 参数结构与供应商兼容回归测试。"""

import unittest

from pydantic import ValidationError

from app.agents.tools import AskUserQuestion, normalize_ask_user_questions


class AskUserSchemaTests(unittest.TestCase):
    def test_normalizes_description_only_options_before_persistence(self):
        raw = [
            {
                "header": "功能模块",
                "question": "需要哪些功能？",
                "multi": True,
                "options": [
                    {
                        "description": "添加、编辑和删除图书",
                        "description_en": "Add, edit and delete books",
                    },
                    {"label": "搜索", "description": "按书名或作者搜索"},
                ],
            }
        ]

        normalized = normalize_ask_user_questions(raw)

        self.assertEqual(
            normalized,
            [
                {
                    "header": "功能模块",
                    "question": "需要哪些功能？",
                    "multi": True,
                    "options": [
                        {"label": "添加、编辑和删除图书"},
                        {"label": "搜索", "description": "按书名或作者搜索"},
                    ],
                }
            ],
        )
        # 新请求会先在 loop 规范化；部署前已存在的 checkpoint 会直接重进
        # Pydantic schema，两条路径都必须把同一选项恢复成 label。
        question = AskUserQuestion.model_validate(raw[0])
        self.assertEqual(question.options[0].label, "添加、编辑和删除图书")
        question = AskUserQuestion.model_validate(normalized[0])
        self.assertEqual(question.options[0].label, "添加、编辑和删除图书")

    def test_rejects_unrenderable_option_objects(self):
        with self.assertRaises(ValidationError):
            AskUserQuestion.model_validate(
                {
                    "question": "选择功能",
                    "multi": True,
                    "options": [{"description_en": "Search"}],
                }
            )

    def test_single_choice_requires_two_options(self):
        with self.assertRaises(ValidationError):
            AskUserQuestion.model_validate(
                {
                    "question": "选择风格",
                    "options": ["极简"],
                }
            )

if __name__ == "__main__":
    unittest.main()

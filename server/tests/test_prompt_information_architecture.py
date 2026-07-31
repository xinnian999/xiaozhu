"""生成提示词的信息架构约束回归测试。"""

import unittest

from app.agents.prompts import SYSTEM_PROMPT


class PromptInformationArchitectureTests(unittest.TestCase):
    def test_model_decides_page_structure_without_asking_user(self):
        """普通用户只选择内容，单页或多路由由模型按职责判断。"""
        self.assertIn("限制的是无意义的代码文件拆分", SYSTEM_PROMPT)
        self.assertIn("禁止向用户询问“单页还是多路由”", SYSTEM_PROMPT)
        self.assertIn("页面组织方式由你根据内容结构自行判断", SYSTEM_PROMPT)
        self.assertIn("你希望网站包含哪些内容", SYSTEM_PROMPT)
        self.assertIn("不要出现“路由、锚点、信息架构”等术语", SYSTEM_PROMPT)

    def test_clear_multi_route_signals_are_mandatory(self):
        """有独立内容目的地时不能为了省文件退化成单页锚点。"""
        self.assertIn("列表 + 详情", SYSTEM_PROMPT)
        self.assertIn("需要独立地址以便进入、刷新、分享或收藏", SYSTEM_PROMPT)
        self.assertIn("分类、归档、标签、搜索或分页", SYSTEM_PROMPT)
        self.assertIn("博客、文档站、商城默认按多路由实现", SYSTEM_PROMPT)
        self.assertIn("拿不准时优先保护内容的独立访问能力", SYSTEM_PROMPT)
        self.assertIn("不能用\n  `href=\"#about\"`", SYSTEM_PROMPT)

    def test_small_linear_experience_can_stay_single_page(self):
        """单一、短而线性的展示内容仍可合理使用单页锚点。"""
        self.assertIn("简介、少量展示内容与联系表单", SYSTEM_PROMPT)
        self.assertIn("在同一页面按 section 组织", SYSTEM_PROMPT)

    def test_explicit_page_request_uses_real_route(self):
        self.assertIn("新增 XX 页面 / XX 页 / 详情页 / 列表页", SYSTEM_PROMPT)
        self.assertIn("禁止把\n  “页面”擅自降级解释成当前页", SYSTEM_PROMPT)


if __name__ == "__main__":
    unittest.main()

#!/usr/bin/env python3
"""部署回调解析的最小回归测试。"""

from __future__ import annotations

import unittest

from server import parse_deploy_payload


def payload(tag: str = "2026.07.27-1") -> dict[str, object]:
    return {
        "push_data": {
            "digest": "sha256:" + ("a" * 64),
            "pushed_at": "2026-07-27 00:00:00",
            "tag": tag,
        },
        "repository": {
            "name": "xiaozhu",
            "namespace": "elin",
            "region": "cn-beijing",
            "repo_full_name": "elin/xiaozhu",
        },
    }


class ParseDeployPayloadTest(unittest.TestCase):
    def test_accepts_release_image(self) -> None:
        tag, digest = parse_deploy_payload(payload())
        self.assertEqual(tag, "2026.07.27-1")
        self.assertEqual(digest, "sha256:" + ("a" * 64))

    def test_rejects_manual_image_tag(self) -> None:
        with self.assertRaisesRegex(ValueError, "正式版本"):
            parse_deploy_payload(payload("latest"))

    def test_rejects_other_repository(self) -> None:
        request_payload = payload()
        request_payload["repository"]["repo_full_name"] = "elin/other"
        with self.assertRaisesRegex(ValueError, "仓库不匹配"):
            parse_deploy_payload(request_payload)

    def test_rejects_other_region(self) -> None:
        request_payload = payload()
        request_payload["repository"]["region"] = "cn-hangzhou"
        with self.assertRaisesRegex(ValueError, "地域不匹配"):
            parse_deploy_payload(request_payload)


if __name__ == "__main__":
    unittest.main()

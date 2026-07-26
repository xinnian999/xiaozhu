#!/usr/bin/env python3
"""接收阿里云 ACR 镜像推送回调，并把正式版本交给部署脚本。"""

from __future__ import annotations

import hmac
import json
import os
import re
import subprocess
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlparse


TOKEN = os.environ.get("DEPLOY_TOKEN", "")
EXPECTED_REPOSITORY = os.environ.get("DEPLOY_REPOSITORY", "elin/xiaozhu")
EXPECTED_REGION = os.environ.get("DEPLOY_REGION", "cn-beijing")
DEPLOY_SCRIPT = os.environ.get(
    "DEPLOY_SCRIPT",
    "/opt/xiaozhu-deploy/deploy.sh",
)
LOCK_FILE = os.environ.get(
    "DEPLOY_LOCK_FILE",
    "/tmp/xiaozhu-deploy.lock",
)
LOG_FILE = os.environ.get(
    "DEPLOY_LOG_FILE",
    "/var/log/xiaozhu-deploy.log",
)
MAX_BODY_BYTES = 64 * 1024

# ACR 构建规则会把 release-v<版本> 转成镜像标签 <版本>。
# 正式版本必须以数字开头，从源头排除 latest、preview-* 等手工镜像。
RELEASE_TAG_RE = re.compile(r"^[0-9][0-9A-Za-z._-]*$")
DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")


def parse_deploy_payload(payload: Any) -> tuple[str, str]:
    """校验 ACR 回调归属，并返回镜像标签和摘要。"""
    if not isinstance(payload, dict):
        raise ValueError("请求体必须是 JSON 对象")

    push_data = payload.get("push_data")
    repository = payload.get("repository")
    if not isinstance(push_data, dict) or not isinstance(repository, dict):
        raise ValueError("缺少 ACR push_data 或 repository")

    tag = push_data.get("tag")
    digest = push_data.get("digest", "")
    if not isinstance(tag, str) or not RELEASE_TAG_RE.fullmatch(tag):
        raise ValueError("不是允许部署的正式版本标签")
    if digest and (
        not isinstance(digest, str) or not DIGEST_RE.fullmatch(digest)
    ):
        raise ValueError("镜像摘要格式无效")

    full_name = repository.get("repo_full_name")
    if not full_name:
        namespace = repository.get("namespace")
        name = repository.get("name")
        full_name = f"{namespace}/{name}"
    if full_name != EXPECTED_REPOSITORY:
        raise ValueError("镜像仓库不匹配")
    if repository.get("region") != EXPECTED_REGION:
        raise ValueError("镜像仓库地域不匹配")

    return tag, digest


class Handler(BaseHTTPRequestHandler):
    server_version = "xiaozhu-deploy/2.0"

    def log_message(self, fmt: str, *args: object) -> None:
        """写入独立日志，并始终遮盖 URL 中的部署密钥。"""
        with open(LOG_FILE, "a", encoding="utf-8") as log_file:
            message = fmt % args
            message = re.sub(r"token=[^ &\"]+", "token=***", message)
            timestamp = time.strftime("%Y-%m-%dT%H:%M:%S%z")
            log_file.write(f"{timestamp} {message}\n")

    def _json(self, status: HTTPStatus, payload: dict[str, object]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self) -> bool:
        parsed = urlparse(self.path)
        query_token = parse_qs(parsed.query).get("token", [""])[0]
        header_token = self.headers.get("X-Deploy-Token", "")
        supplied_token = header_token or query_token
        return bool(TOKEN) and hmac.compare_digest(supplied_token, TOKEN)

    def _read_payload(self) -> Any:
        raw_length = self.headers.get("Content-Length", "")
        try:
            content_length = int(raw_length)
        except ValueError as exc:
            raise ValueError("Content-Length 无效") from exc
        if content_length <= 0 or content_length > MAX_BODY_BYTES:
            raise ValueError("请求体大小无效")

        body = self.rfile.read(content_length)
        try:
            return json.loads(body)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError("请求体不是有效 JSON") from exc

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/healthz":
            self._json(HTTPStatus.OK, {"ok": True})
            return
        if parsed.path == "/deploy/xiaozhu":
            self._json(
                HTTPStatus.METHOD_NOT_ALLOWED,
                {"ok": False, "error": "请使用 POST"},
            )
            return
        self._json(
            HTTPStatus.NOT_FOUND,
            {"ok": False, "error": "not found"},
        )

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path != "/deploy/xiaozhu":
            self._json(
                HTTPStatus.NOT_FOUND,
                {"ok": False, "error": "not found"},
            )
            return
        if not self._authorized():
            self._json(
                HTTPStatus.FORBIDDEN,
                {"ok": False, "error": "forbidden"},
            )
            return

        try:
            tag, digest = parse_deploy_payload(self._read_payload())
            # 不使用 -n：若上一个版本仍在部署，新版本会排队，避免静默丢失发布。
            subprocess.Popen(
                [
                    "/usr/bin/flock",
                    LOCK_FILE,
                    DEPLOY_SCRIPT,
                    tag,
                    digest,
                ],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
        except ValueError as exc:
            self._json(
                HTTPStatus.BAD_REQUEST,
                {"ok": False, "error": str(exc)},
            )
            return
        except OSError:
            self._json(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                {"ok": False, "error": "无法启动部署任务"},
            )
            return

        self._json(
            HTTPStatus.ACCEPTED,
            {"ok": True, "message": "deploy queued", "tag": tag},
        )


if __name__ == "__main__":
    if not TOKEN:
        raise SystemExit("DEPLOY_TOKEN 未配置")
    ThreadingHTTPServer(("0.0.0.0", 19001), Handler).serve_forever()

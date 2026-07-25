import os
from unittest import TestCase
from unittest.mock import patch

from pydantic import ValidationError

from app import model_providers
from app.config import Settings


class StreamChunkTimeoutConfigTests(TestCase):
    def test_stream_chunk_timeout_defaults_to_300_seconds(self):
        with patch.dict(os.environ):
            os.environ.pop("QWEN_STREAM_CHUNK_TIMEOUT_S", None)
            configured = Settings(_env_file=None)

        self.assertEqual(
            configured.qwen_stream_chunk_timeout_s,
            300.0,
        )

    def test_environment_can_override_stream_chunk_timeout(self):
        with patch.dict(
            os.environ,
            {"QWEN_STREAM_CHUNK_TIMEOUT_S": "240"},
        ):
            configured = Settings(_env_file=None)

        self.assertEqual(
            configured.qwen_stream_chunk_timeout_s,
            240.0,
        )

    def test_non_positive_stream_chunk_timeout_is_rejected(self):
        with (
            patch.dict(os.environ, {"QWEN_STREAM_CHUNK_TIMEOUT_S": "0"}),
            self.assertRaises(ValidationError),
        ):
            Settings(_env_file=None)

    def test_qwen_receives_environment_override_without_affecting_openai(self):
        with patch.dict(os.environ, {"QWEN_STREAM_CHUNK_TIMEOUT_S": "240"}):
            os.environ.pop("LANGCHAIN_OPENAI_STREAM_CHUNK_TIMEOUT_S", None)
            configured = Settings(_env_file=None)
            with patch.object(model_providers, "settings", configured):
                qwen = model_providers.build_chat_model(
                    {
                        "id": "qwen-test",
                        "provider": "qwen",
                        "api_key": "test-key",
                        "base_url": "https://example.com/v1",
                    }
                )
                openai = model_providers.build_chat_model(
                    {
                        "id": "openai-test",
                        "provider": "openai",
                        "api_key": "test-key",
                        "base_url": "https://example.com/v1",
                    }
                )

        self.assertEqual(qwen.stream_chunk_timeout, 240.0)
        self.assertEqual(openai.stream_chunk_timeout, 120.0)

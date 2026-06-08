"""探测脚本：逐个测白名单里的模型「能不能识图」。

用途：图片输入（multimodal）只有视觉模型（VLM）才支持。本脚本给每个模型发一张
「已知颜色的纯色图 + 一句提问」，看它能否答对颜色，从而判定它支不支持识图。
跑完会打一张汇总表，方便你决定给 AVAILABLE_MODELS 的哪些模型加 vision=True。

判定三态：
  ✅ 支持      —— 调用成功且答对了颜色（确实看懂了图）
  ⚠️ 存疑      —— 调用成功但没答对（收下了图却没看懂，或答非所问）
  ❌ 不支持    —— 调用直接报错（中转/模型拒绝多模态输入，最典型的「不支持」信号）

运行（必须在 server 目录下，才能正确加载 .env）：
    uv run python scripts/check_vision.py            # 测白名单全部模型
    uv run python scripts/check_vision.py gpt-5.5    # 只测指定的一个或多个

注意：这是一次性诊断脚本，不接入应用主流程，所以放在 scripts/ 下独立运行。
"""

import struct
import sys
import zlib

# 让脚本能 import 到 app.*：把 server/ 根目录（本文件的上一级的上一级）加进 sys.path。
# 直接 `uv run python scripts/xxx.py` 时，sys.path[0] 是 scripts/ 而不是 server/，
# 不加这行会 import 不到 app 包。
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from langchain_core.messages import HumanMessage  # noqa: E402

from app.llm import AVAILABLE_MODELS, build_llm  # noqa: E402


# ── 造一张「已知颜色」的测试图 ──────────────────────────────────────────────────
# 故意不依赖 Pillow：手写一个极简 PNG 编码器（纯标准库 zlib + struct），
# 生成一张 16×16 的纯色图。这样脚本零额外依赖、开箱即跑。
#
# 为什么用纯色 + 问颜色：答案空间小、好自动判分，且纯文本模型「猜」也难恰好猜中。
# 用三原色（红/绿/蓝）做候选，模型只要真看到了图就能一口答对。

# 候选颜色：名字 → RGB。提问时让模型从这三个里选，判分时按名字匹配。
COLORS = {
    "red": (220, 30, 30),
    "green": (30, 200, 60),
    "blue": (40, 80, 230),
}


def _png_chunk(tag: bytes, data: bytes) -> bytes:
    """拼一个 PNG 数据块：长度(4B) + 类型(4B) + 数据 + CRC32(4B)。PNG 的固定格式。"""
    return (
        struct.pack(">I", len(data))
        + tag
        + data
        + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    )


def make_solid_png(rgb: tuple[int, int, int], size: int = 16) -> bytes:
    """生成一张 size×size 的纯色 PNG，返回原始字节。"""
    r, g, b = rgb
    # 每行：1 个滤波器字节(0=不滤波) + size 个像素(每像素 RGB 三字节)
    row = bytes([0]) + bytes([r, g, b] * size)
    raw = row * size
    return b"".join([
        b"\x89PNG\r\n\x1a\n",  # PNG 签名（固定魔数）
        _png_chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)),  # 8 位深、颜色类型2=真彩
        _png_chunk(b"IDAT", zlib.compress(raw)),  # 像素数据，zlib 压缩
        _png_chunk(b"IEND", b""),  # 结束块
    ])


def make_data_url(rgb: tuple[int, int, int]) -> str:
    """把纯色 PNG 编成 data URL（base64 内联），就是发给模型的图片字段格式。"""
    import base64

    b64 = base64.b64encode(make_solid_png(rgb)).decode()
    return f"data:image/png;base64,{b64}"


# ── 探测单个模型 ────────────────────────────────────────────────────────────────

PROMPT = (
    "这张图片是纯色的。它的颜色是下面哪一个？"
    "只用一个英文单词回答，从 red / green / blue 三者里选一个，不要加任何标点或解释。"
)


def probe(model_id: str, expect: str, data_url: str) -> tuple[str, str]:
    """给一个模型发「图 + 提问」，返回 (判定状态, 说明)。

    判定状态取值：'ok' / 'maybe' / 'no'，对应汇总表里的 ✅ / ⚠️ / ❌。
    """
    try:
        # 不 bind_tools —— 纯测视觉，越简单越好。复用 build_llm 保证 base_url / key 跟主程序一致。
        llm = build_llm(model_id)
        msg = HumanMessage(content=[
            {"type": "text", "text": PROMPT},
            {"type": "image_url", "image_url": {"url": data_url}},
        ])
        resp = llm.invoke([msg])
        # 回复可能是字符串或内容块列表，统一取纯文本再小写归一化
        content = resp.content
        text = content if isinstance(content, str) else "".join(
            b.get("text", "") if isinstance(b, dict) else str(b) for b in content
        )
        answer = text.strip().lower()
        if expect in answer:
            return "ok", f'答「{answer}」✓ 命中 {expect}'
        return "maybe", f'答「{answer}」✗ 期望 {expect}（收图但没看懂 / 答非所问）'
    except Exception as e:
        # 多模态被拒最典型的就是这里抛错（400/不支持 image 等）。
        # 特判一个易误解的坑：'str' object has no attribute 'model_dump' ——
        # 这不是脚本 bug，而是中转站对图片请求没返回标准 JSON、而是吐了一段裸字符串
        # （通常是它自己的报错文本），langchain 拿字符串当响应对象解析才崩的。
        # 实际含义就是：这个模型经当前中转「图片输入跑不通」，判定为不支持。
        msg = str(e)
        if "model_dump" in msg:
            return "no", "中转对图片请求返回了非标准响应（裸字符串），图片输入实际不可用"
        return "no", f"调用报错：{type(e).__name__}: {msg[:120]}"


# ── 主流程 ──────────────────────────────────────────────────────────────────────

def main() -> None:
    # 命令行传了模型 id 就只测这些，否则测白名单全部
    wanted = sys.argv[1:]
    all_ids = [m["id"] for m in AVAILABLE_MODELS]
    targets = wanted or all_ids

    # 校验传入的 id 都在白名单里，避免拼错了还傻测
    unknown = [m for m in targets if m not in all_ids]
    if unknown:
        print(f"⚠️  这些 id 不在白名单里，已跳过：{unknown}")
        targets = [m for m in targets if m in all_ids]

    # 用同一轮颜色顺序：第 i 个模型测第 i 种颜色（轮询），让不同模型测到不同颜色，
    # 顺手能发现「不管什么图都答同一个颜色」这种假阳性。
    color_names = list(COLORS.keys())

    print(f"\n开始探测 {len(targets)} 个模型的识图能力…\n")
    results: list[tuple[str, str, str]] = []
    for i, model_id in enumerate(targets):
        expect = color_names[i % len(color_names)]
        data_url = make_data_url(COLORS[expect])
        print(f"  → 测 {model_id}（图为 {expect}）…", flush=True)
        status, detail = probe(model_id, expect, data_url)
        results.append((model_id, status, detail))

    # 汇总表
    icon = {"ok": "✅ 支持", "maybe": "⚠️ 存疑", "no": "❌ 不支持"}
    width = max(len(m) for m in targets) if targets else 0
    print("\n" + "═" * 60)
    print("识图能力探测结果")
    print("═" * 60)
    for model_id, status, detail in results:
        print(f"  {model_id.ljust(width)}  {icon[status]}")
        print(f"  {' ' * width}  └─ {detail}")
    print("═" * 60)
    oks = [m for m, s, _ in results if s == "ok"]
    print(f"\n可识图的模型（建议标 vision=True）：{oks or '无'}\n")


if __name__ == "__main__":
    main()

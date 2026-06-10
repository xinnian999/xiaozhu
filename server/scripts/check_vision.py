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


def make_two_color_png(
    left: tuple[int, int, int], right: tuple[int, int, int], w: int = 240, h: int = 120
) -> bytes:
    """生成一张「左半 left 色、右半 right 色」的 PNG，返回原始字节。

    为什么用双色而不是纯色：纯色图答案空间只有 3 种，没视觉的模型瞎猜也可能蒙中
    （假阳性，qwen3-coder-next 当初就这么被误标成支持）。双色图要求同时读对「左、右
    两个区域」的颜色，答案空间是 3×3，且必须真看到「左右分块」结构才能答对，蒙不过去。
    """
    half = w // 2
    raw = b""
    for _ in range(h):
        # 每行：1 个滤波器字节(0=不滤波) + 左半 left 像素 + 右半 right 像素
        raw += bytes([0]) + bytes(list(left) * half) + bytes(list(right) * (w - half))
    return b"".join([
        b"\x89PNG\r\n\x1a\n",  # PNG 签名（固定魔数）
        _png_chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)),  # 8 位深、颜色类型2=真彩
        _png_chunk(b"IDAT", zlib.compress(raw)),  # 像素数据，zlib 压缩
        _png_chunk(b"IEND", b""),  # 结束块
    ])


def make_data_url(left: tuple[int, int, int], right: tuple[int, int, int]) -> str:
    """把双色 PNG 编成 data URL（base64 内联），就是发给模型的图片字段格式。"""
    import base64

    b64 = base64.b64encode(make_two_color_png(left, right)).decode()
    return f"data:image/png;base64,{b64}"


# ── 探测单个模型 ────────────────────────────────────────────────────────────────

PROMPT = (
    "这张图片由左右两个等宽的色块拼成。左半边和右半边分别是什么颜色？"
    "每个颜色都从 red / green / blue 三者里选一个英文单词，"
    "严格按「left=颜色 right=颜色」的格式回答，不要加别的解释。"
)


# 测试用的颜色对：相邻配对，保证左右一定不同色，且三组合起来覆盖全部三种颜色。
TEST_PAIRS = [("red", "green"), ("green", "blue"), ("blue", "red")]


def _ask_once(llm, left: str, right: str) -> str:
    """发一张「左 left / 右 right」的双色图问颜色，返回小写归一化后的回答文本。"""
    data_url = make_data_url(COLORS[left], COLORS[right])
    resp = llm.invoke([HumanMessage(content=[
        {"type": "text", "text": PROMPT},
        {"type": "image_url", "image_url": {"url": data_url}},
    ])])
    content = resp.content
    text = content if isinstance(content, str) else "".join(
        b.get("text", "") if isinstance(b, dict) else str(b) for b in content
    )
    return text.strip().lower()


def probe(model_id: str) -> tuple[str, str]:
    """对一个模型连测 TEST_PAIRS 三组不同的双色图，必须全部答对才算「支持」。

    判定状态取值：'ok' / 'maybe' / 'no'，对应汇总表里的 ✅ / ⚠️ / ❌。

    为什么要多组、且要求全对：没视觉的模型往往不看图、对任何输入都吐一个「固定答案」
    （实测 qwen3-coder-next 不管图是红绿还是蓝红，都答 left=red right=blue）。单组测试时
    这种固定答案可能恰好撞上一次期望、给出假阳性 —— 当初 coder 就是这么被误标成支持的。
    连测三组覆盖全部颜色，固定答案必然在某一组对不上，从而被识破：
      三组全对 = ✅ 真看到了图；对一部分 = ⚠️ 收图但不稳/没看准；全错或报错 = ❌ 不支持。
    """
    try:
        # 不 bind_tools —— 纯测视觉，越简单越好。复用 build_llm 保证 base_url / key 跟主程序一致。
        llm = build_llm(model_id)
        hits = 0
        answers: list[str] = []
        for left, right in TEST_PAIRS:
            answer = _ask_once(llm, left, right)
            answers.append(answer)
            # 在 "left=.. right=.." 里分别截出左右两段各自判色，避免把右边的词算到左边
            left_seg, _, right_seg = answer.partition("right")
            if left in left_seg and right in right_seg:
                hits += 1
        total = len(TEST_PAIRS)
        if hits == total:
            return "ok", f"{hits}/{total} 组全部答对（真看到了图）"
        if hits == 0:
            # 三组答案完全一样 → 强烈的「不看图、固定输出」信号
            fixed = len(set(answers)) == 1
            note = "三组答案完全相同，疑似不看图给固定答案" if fixed else "全部答错"
            return "no", f"{hits}/{total} 组对；{note}：「{answers[0][:50]}」"
        return "maybe", f"{hits}/{total} 组对（收图但不稳 / 没看准）"
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

    print(f"\n开始探测 {len(targets)} 个模型的识图能力（每个连测 {len(TEST_PAIRS)} 组双色图）…\n")
    results: list[tuple[str, str, str]] = []
    for model_id in targets:
        print(f"  → 测 {model_id}…", flush=True)
        status, detail = probe(model_id)
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

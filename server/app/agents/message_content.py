"""LangChain 多模态 HumanMessage content 的统一构造。"""


def build_human_content(
    text: str,
    images: list[str] | None,
) -> str | list[dict]:
    """把文本与 data URL / 远程图片拼成 LangChain 标准内容块。

    标准 ``image`` block 会由各 provider 适配器转换成自己的 wire format，不能在业务层
    写死 OpenAI 的 ``image_url`` 结构。
    """
    if not images:
        return text
    blocks: list[dict] = []
    if text:
        blocks.append({"type": "text", "text": text})
    for url in images:
        if url.startswith("data:") and ";base64," in url:
            header, data = url.split(",", 1)
            mime_type = header[5:].split(";", 1)[0] or "image/png"
            blocks.append({"type": "image", "base64": data, "mime_type": mime_type})
        else:
            blocks.append({"type": "image", "url": url})
    return blocks


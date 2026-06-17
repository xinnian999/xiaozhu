"""支付宝客户端构造 —— 把 .env 里的沙箱配置组装成一个 AliPay 实例。

用的是 python-alipay-sdk（import 名是 alipay）。它封装了下单/查单/验签：
  - api_alipay_trade_precreate(...)  当面付·扫码下单 → 返回二维码
  - api_alipay_trade_query(...)      主动查一笔订单的支付状态
  - verify(data, signature)          验异步回调的签名

密钥从文件读（路径见 config），不进 .env、不进仓库。沙箱网关用 config 里配的地址覆盖
（沙箱网关换过几次，不写死，以控制台为准）。
"""

from functools import lru_cache
from pathlib import Path

from alipay import AliPay
from fastapi import HTTPException

from app.config import settings


def _normalize_pem(raw: str, header: str) -> str:
    """把密钥内容规整成带头尾的 PEM。

    支付宝控制台「复制私钥/公钥」给的是**没有头尾行的裸 base64**，而签名库要的是标准 PEM。
    这里自动补：已经有 BEGIN 头就原样返回；否则去掉所有空白、按 64 字符折行、套上头尾。
    这样你直接把支付宝复制的串塞进文件即可，不用手拼头尾（少踩一个坑）。

    header 形如 "PRIVATE KEY"（应用私钥用 JAVA 语言那版=PKCS#8）/ "PUBLIC KEY"（支付宝公钥）。
    """
    raw = raw.strip()
    if "-----BEGIN" in raw:
        return raw
    body = "".join(raw.split())
    lines = [body[i:i + 64] for i in range(0, len(body), 64)]
    return f"-----BEGIN {header}-----\n" + "\n".join(lines) + f"\n-----END {header}-----\n"


def _read_key(path_str: str, what: str, header: str) -> str:
    """读一个密钥文件并规整成 PEM。缺文件 / 没配就报清楚的错。"""
    if not path_str:
        raise HTTPException(status_code=500, detail=f"支付未配置：{what} 路径为空，请在 .env 设置。")
    # 路径相对 server/ 根目录（本文件的上一级的上一级）
    path = Path(path_str)
    if not path.is_absolute():
        path = Path(__file__).resolve().parent.parent / path
    if not path.exists():
        raise HTTPException(status_code=500, detail=f"支付未配置：找不到{what}文件 {path}")
    return _normalize_pem(path.read_text(encoding="utf-8"), header)


@lru_cache(maxsize=1)
def build_alipay() -> AliPay:
    """构造（并缓存）一个 AliPay 客户端。配置缺失时抛 HTTPException，便于接口层直接回错。

    lru_cache：客户端无状态、可复用，没必要每次请求都重建（读文件 + 解析密钥有开销）。
    """
    if not settings.alipay_app_id:
        raise HTTPException(status_code=500, detail="支付未配置：ALIPAY_APP_ID 为空，请在 .env 设置。")

    # 应用私钥用「JAVA语言」那版（PKCS#8）→ 头是 "PRIVATE KEY"；支付宝公钥 → "PUBLIC KEY"
    app_private_key = _read_key(settings.alipay_app_private_key_path, "应用私钥", "PRIVATE KEY")
    alipay_public_key = _read_key(settings.alipay_alipay_public_key_path, "支付宝公钥", "PUBLIC KEY")

    client = AliPay(
        appid=settings.alipay_app_id,
        # 默认异步通知地址；下单时也可单独传，留空就不用异步通知（本地走主动查单）
        app_notify_url=settings.alipay_notify_url or None,
        app_private_key_string=app_private_key,
        alipay_public_key_string=alipay_public_key,
        sign_type="RSA2",   # 沙箱 / 线上都用 RSA2
        debug=True,         # True = 走沙箱（SDK 内置沙箱网关）
    )
    # 用 .env 配的网关覆盖 SDK 内置的沙箱地址（沙箱网关地址以控制台为准，避免内置的旧地址失效）
    if settings.alipay_gateway:
        client._gateway = settings.alipay_gateway
    return client

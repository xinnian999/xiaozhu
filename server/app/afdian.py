"""爱发电（afdian / ifdian.net）客户端 —— 拼付款链接 + 调 API 核单。

爱发电的接入模型和支付宝完全不同：它没有「后端签名直接跳收银台」那套，而是
  1. 我们在爱发电建好「商品(售卖)」，每个商品有 plan_id + sku_id；
  2. 把用户引到爱发电的下单页，URL 上带 custom_order_id（= 我们自己的订单号）；
  3. 用户付款后，爱发电通过 webhook 通知我们，并把 custom_order_id 原样回传；
  4. 我们再用 token 签名、调 query-order 接口**主动核单**（金额/状态以接口为准，webhook 只当触发器）。

本模块封装 2 和 4：build_pay_url（拼链接）、query_order / find_order_by_custom_id（核单/查单）。
签名规则见 https://ifdian.net/dashboard/dev 的文档。
"""

import hashlib
import json
import time
from urllib.parse import quote

import httpx
from fastapi import HTTPException

from app.runtime_config import cfg

# 爱发电开放接口根地址（注意是 ifdian.net，不是 afdian.com，两个域名不通用）
API_BASE = "https://ifdian.net/api/open"
# 用户被引导去付款的下单页
ORDER_CREATE_URL = "https://ifdian.net/order/create"


def plan_sku_for(tier: str) -> tuple[str, str] | None:
    """把我们的档位（pro / max）映射到爱发电的 (plan_id, sku_id)。

    值来自 .env 的 AFDIAN_*。任一为空（没配）就返回 None，调用方据此报「未配置」。
    free 不可购买，自然查不到。
    """
    mapping = {
        "pro": (cfg.afdian_pro_plan_id, cfg.afdian_pro_sku_id),
        "max": (cfg.afdian_max_plan_id, cfg.afdian_max_sku_id),
    }
    pair = mapping.get(tier)
    if not pair or not pair[0] or not pair[1]:
        return None
    return pair


def build_pay_url(tier: str, custom_order_id: str) -> str:
    """拼出爱发电下单页链接，把我们的订单号塞进 custom_order_id 透传。

    亲测的 URL 形态（来自商品页「发电」按钮跳转）：
      https://ifdian.net/order/create
        ?product_type=1                         # 1 = 售卖商品
        &plan_id=<商品id>
        &sku=[{"sku_id":"<型号id>","count":1}]  # 需 URL 编码
        &custom_order_id=<我们的订单号>          # 付款后原样回传到 webhook
    """
    pair = plan_sku_for(tier)
    if pair is None:
        raise HTTPException(status_code=500, detail=f"爱发电未配置该档位的商品：{tier}")
    plan_id, sku_id = pair
    # sku 是个 JSON 数组，紧凑写法后整体 URL 编码
    sku = json.dumps([{"sku_id": sku_id, "count": 1}], separators=(",", ":"))
    return (
        f"{ORDER_CREATE_URL}?product_type=1"
        f"&plan_id={plan_id}"
        f"&sku={quote(sku)}"
        f"&custom_order_id={quote(custom_order_id)}"
    )


def _sign(params: str, ts: int) -> str:
    """按爱发电规则算签名：md5(token + 'params' + {params} + 'ts' + {ts} + 'user_id' + {user_id})。

    注意 params 必须是「最终发送的那个 JSON 字符串」本身（含紧凑格式），多一个空格都会验签失败。
    """
    raw = f"{cfg.afdian_token}params{params}ts{ts}user_id{cfg.afdian_user_id}"
    return hashlib.md5(raw.encode("utf-8")).hexdigest()


async def _call(endpoint: str, params: dict) -> dict:
    """调爱发电开放接口，返回解析后的 data 部分；失败抛 RuntimeError。

    请求体四件套：user_id（我是谁）、params（业务参数 JSON 串）、ts（秒级时间戳）、sign（防伪签名）。
    """
    if not cfg.afdian_token or not cfg.afdian_user_id:
        raise RuntimeError("爱发电未配置：AFDIAN_TOKEN / AFDIAN_USER_ID 为空")
    # params 先序列化成紧凑 JSON 串，这个串既要参与签名、也要原样发出去（两处必须完全一致）
    params_str = json.dumps(params, separators=(",", ":"))
    ts = int(time.time())
    payload = {
        "user_id": cfg.afdian_user_id,
        "params": params_str,
        "ts": ts,
        "sign": _sign(params_str, ts),
    }
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.post(f"{API_BASE}/{endpoint}", json=payload)
    resp.raise_for_status()
    body = resp.json()
    if body.get("ec") != 200:
        raise RuntimeError(f"爱发电接口 {endpoint} 返回错误：{body.get('ec')} {body.get('em')}")
    return body.get("data") or {}


async def query_order(out_trade_no: str) -> dict | None:
    """按爱发电订单号 out_trade_no 查一笔订单，返回订单字典；查不到返回 None。

    webhook 收到通知后用它**主动核单**：金额、状态都以这里返回的为准，不轻信 webhook 报文。
    """
    data = await _call("query-order", {"out_trade_no": out_trade_no})
    lst = data.get("list") or []
    return lst[0] if lst else None


async def find_order_by_custom_id(custom_order_id: str) -> dict | None:
    """按我们的订单号（custom_order_id）在最近订单里找一笔，返回订单字典；找不到返回 None。

    用途：前端轮询时的「兜底查单」。爱发电 query-order 只支持按它自己的 out_trade_no 或翻页查，
    不支持直接按 custom_order_id 查，所以这里翻第一页（最近 50 条）扫一遍。够小项目用；
    真有大量并发订单时再考虑按 out_trade_no 精确查（需先从 webhook 拿到 out_trade_no）。
    """
    data = await _call("query-order", {"page": 1, "per_page": 50})
    for order in data.get("list") or []:
        if order.get("custom_order_id") == custom_order_id:
            return order
    return None

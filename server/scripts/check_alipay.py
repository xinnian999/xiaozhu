"""支付宝沙箱冒烟测试：直接发起一笔「当面付·扫码」下单，拿到二维码。

这是接支付的第 1 步——不碰数据库、不起服务，纯粹验证：APPID / 应用私钥 / 支付宝公钥 /
网关 这套配置是不是全对、能不能成功调用支付宝。跑通了才往下做下单接口 / 查单 / 前端。

跑之前先在 .env 配好 ALIPAY_APP_ID / ALIPAY_GATEWAY，并把两个密钥放到 keys/ 下
（路径见 config）。然后：
    uv run python scripts/check_alipay.py

成功的话会打印二维码（终端里直接是可扫的 ASCII 图）+ 一个 qr_code 链接。
用「沙箱版支付宝 App」登录沙箱买家账号扫它付款，就能在沙箱里完成一笔支付。
"""

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.alipay import build_alipay  # noqa: E402


def main() -> None:
    alipay = build_alipay()

    # 商户订单号：我们这边的唯一单号（也是给支付宝的幂等键）。这里用时间戳凑一个测试单号。
    out_trade_no = f"SMOKE{int(time.time())}"

    print(f"发起当面付下单：out_trade_no={out_trade_no} 金额=0.01 …\n")
    result = alipay.api_alipay_trade_precreate(
        out_trade_no=out_trade_no,
        total_amount="0.01",      # 沙箱随便给个小额
        subject="Vibuild 沙箱冒烟测试",
    )

    # 返回是「alipay_trade_precreate_response」节点的内容：code=10000 表示成功
    code = result.get("code")
    if code != "10000":
        print("❌ 下单失败：")
        print(f"   code={code} msg={result.get('msg')} sub_msg={result.get('sub_msg')}")
        print("   常见原因：APPID/密钥不匹配、网关填错、密钥不是 RSA2、应用未签约当面付。")
        return

    qr_code = result["qr_code"]
    print("✅ 下单成功！用沙箱版支付宝 App（沙箱买家账号）扫下面的码付款：\n")

    # 终端打印可扫的 ASCII 二维码（qrcode 是 dev 依赖）
    try:
        import qrcode

        qr = qrcode.QRCode(border=1)
        qr.add_data(qr_code)
        qr.make()
        qr.print_ascii(invert=True)
    except Exception:
        print("（未能在终端渲染二维码，用下面的链接自行生成二维码扫描）")

    print(f"\nqr_code 链接：{qr_code}")
    print(f"订单号：{out_trade_no}")
    print("\n付款后可再写个查单脚本/接口确认到账（下一步做）。")


if __name__ == "__main__":
    main()

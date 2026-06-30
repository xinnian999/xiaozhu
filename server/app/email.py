"""邮件发送 —— 用 Python 标准库 smtplib 走 SMTP 发注册验证码。

为什么丢线程池：smtplib 是**同步阻塞**的（连服务器、登录、发送都会卡住当前线程）。
我们的接口是 async，直接在事件循环里调会把整个服务卡住，所以用 run_in_threadpool
把它挪到线程里跑，不阻塞其它请求。

配置（host/账号/授权码）全在 settings（来自 .env），见 config.py 的 SMTP_* 字段。
"""

import smtplib
from email.message import EmailMessage
from email.utils import formataddr

from fastapi import HTTPException
from fastapi.concurrency import run_in_threadpool

from app.runtime_config import cfg


def _send_sync(to: str, subject: str, body: str) -> None:
    """同步发一封纯文本邮件。配置缺失或发送失败都抛异常，由上层转成 HTTP 错误。"""
    if not cfg.smtp_host or not cfg.smtp_user or not cfg.smtp_password:
        raise HTTPException(status_code=500, detail="邮件未配置：请在 .env 设置 SMTP_*。")

    # EmailMessage 负责把「发件人/收件人/主题/正文」拼成符合规范的邮件报文，
    # 省得我们手拼 MIME 头（中文主题的编码它也会自动处理）。
    msg = EmailMessage()
    # formataddr 把「显示名 + 地址」拼成 "小筑 <xxx@qq.com>" 这种规范写法
    msg["From"] = formataddr((cfg.smtp_from_name, cfg.smtp_user))
    msg["To"] = to
    msg["Subject"] = subject
    msg.set_content(body)

    # 465 用 SSL（整条连接加密）；587 用 STARTTLS（先明文连上再升级为加密）。
    # QQ/163 都推荐 465。timeout 防止 SMTP 服务器没响应时把线程一直挂住。
    if cfg.smtp_port == 465:
        with smtplib.SMTP_SSL(cfg.smtp_host, cfg.smtp_port, timeout=15) as s:
            s.login(cfg.smtp_user, cfg.smtp_password)
            s.send_message(msg)
    else:
        with smtplib.SMTP(cfg.smtp_host, cfg.smtp_port, timeout=15) as s:
            s.starttls()
            s.login(cfg.smtp_user, cfg.smtp_password)
            s.send_message(msg)


async def send_verify_code(to: str, code: str) -> None:
    """给某邮箱发一封注册验证码邮件。在线程池里跑，避免阻塞事件循环。"""
    subject = "小筑 注册验证码"
    body = (
        f"你的小筑注册验证码是：{code}\n\n"
        "10 分钟内有效。如果不是你本人操作，请忽略此邮件。"
    )
    await run_in_threadpool(_send_sync, to, subject, body)

# 支付宝密钥（不进仓库）

把两个 PEM 密钥放这里，文件名要和 .env 里的路径一致：

- `app_private_key.pem` —— 你的**应用私钥**（用支付宝「密钥工具」生成的 RSA2 私钥，PKCS8）
- `alipay_public_key.pem` —— **支付宝公钥**（在沙箱控制台把应用公钥填进去后，平台给你的那串）

PEM 要带头尾行，例如：

```
-----BEGIN PRIVATE KEY-----
MIIE... (一大串)
-----END PRIVATE KEY-----
```

```
-----BEGIN PUBLIC KEY-----
MIIB... (一串)
-----END PUBLIC KEY-----
```

整个 keys/ 目录已被 .gitignore 忽略，密钥不会被提交。

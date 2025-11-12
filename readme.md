
⸻

✅ README.md

# 🛰️ Air-Broker: Cloudflare Worker + Air780E IoT Gateway

通过 Cloudflare Workers 实现的 WebSocket (WSS) 中继服务，用于连接 **Air780E 设备** 与 Web 前端，实现短信收发与远程命令控制。  
前端网页使用 Cloudflare Access 验证后可生成短期 JWT 并安全地与设备通信。

---

## 🚀 项目架构

```
+———————––+

sms-reply.html (前端)
fetch(’/token’) → 需登录
wss://xxxx.com/ws
+————+————+

         |
         v

+———————————–+

Cloudflare Worker (air-broker)
/token → 生成短期 JWT（Access保护）
/ws → WebSocket (PubSubBroker)
Durable Object (SQLite)
+———————————–+

         |
         v

+———————––+
|  Air780E 设备           |
|  使用长期 JWT 连接 /ws     |
|  接收 publish 命令发送短信 |
+———————––+
```
---

## ⚙️ 环境与依赖

### 必要环境
- Node.js ≥ 18
- Cloudflare Wrangler ≥ 3.0
- jose（JWT 签名库）
- dotenv（加载环境变量）

### 安装依赖
```bash
npm install
```

---

🌍 部署步骤

1️⃣ 初始化并登录 Cloudflare

npx wrangler login

2️⃣ 配置 Worker

编辑 wrangler.jsonc：

```
{
  "name": "air-broker",
  "main": "src/index.js",
  "compatibility_date": "2025-11-11",
  "durable_objects": {
    "bindings": [
      { "name": "PUBSUB_BROKER", "class_name": "PubSubBroker" }
    ]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["PubSubBroker"] }
  ],
  "assets": { "directory": "./public" }
}
```

3️⃣ 配置 JWT 主密钥

npx wrangler secret put JWT_MASTER_SECRET

4️⃣ 部署

npx wrangler deploy
⸻

🔐 安全架构

模块	功能	安全策略
/token	生成短期 JWT	✅ 通过 Cloudflare Access 邮箱验证
/ws	WebSocket 通信	✅ Worker 内验证 JWT（HMAC）
sms-reply.html	前端界面	⚠️ 不上锁，但请求 /token 会被拦截
设备 Air780E	使用长期 JWT 连接	✅ 离线安全、无 Access 依赖


⸻

🔑 生成设备 JWT

项目内提供工具：generate-token.js
用于为设备批量生成长期 JWT（有效期至 2035 年）。

1️⃣ 创建 .env

JWT_MASTER_SECRET=你的Base64密钥

2️⃣ 生成 Token

node generate-token.js 185 2001

输出：

=== 设备 185 ===
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...

=== 设备 2001 ===
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...

不会写入文件，直接输出到终端。

⸻

🌐 Cloudflare Access 保护

只保护 /token 路径：
	1.	Cloudflare Zero Trust → Access → Applications → Add Application
	2.	选择 Self-hosted
	3.	Domain 填：xxxx.com
	4.	Path 填：/token
	5.	选择邮箱登录验证（Email OTP）

访问 /sms-reply.html 时，若用户未登录 Access，/token 请求会被拦截，网页自动提示“请登录以继续”。

⸻

💬 开发调试

本地启动（需登录 Cloudflare CLI）：

npx wrangler dev

本地访问：

http://127.0.0.1:8787/sms-reply.html


⸻

📁 项目结构

air-broker/
├─ src/
│  ├─ index.js          # Worker 主入口 (路由: /ws, /token)
│  └─ broker.js         # Durable Object (PubSubBroker)
├─ public/
│  └─ sms-reply.html    # 前端界面
├─ generate-token.js    # 生成设备 JWT 工具
├─ wrangler.jsonc
├─ .env                 # 本地密钥 (忽略上传)
├─ .gitignore
└─ package.json


⸻

⚠️ 注意事项
	•	.env、.env.*、device_tokens.json 已在 .gitignore 中保护；
	•	Cloudflare Access 登录令牌不会缓存到设备端；
	•	Air780E 设备请使用长期 JWT，不依赖网页登录。

⸻

📄 许可证

MIT License © 2025 dagow

---
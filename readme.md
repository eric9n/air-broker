
# 🛰️ Air-Broker

Cloudflare Worker + Durable Object 版的 **Air780E 短信中继与远程控制网关**。  
它把分散在公网的 Air780E 设备、Cloudflare Zero Trust/Access 登录和浏览器控制台整合到一个统一的 WSS/HTTP 服务里，提供：

- 浏览器侧短信控制台（/sms-reply.html + `public/sms-console.js`）
- 支持上行/下行的 MQTT 风格 topic (`air780e/status|contact|command|response`)
- Durable Object + Cloudflare SQLite 持久化设备列表与临时通讯录
- 设备、浏览器双重鉴权 + 多维短信限流

---

## ⭐️ 功能亮点
- **一条 WebSocket 管道搞定设备、浏览器和 DO**：订阅/发布协议极简，Lua 脚本和 JS 客户端共用。
- **两类鉴权**：设备使用 `DEVICE_TOKENS`，浏览器使用一次性访问码 `/auth`→SESSION Cookie（10 分钟 + IP 绑定）。
- **SQLite + 内存双写**：DO 自动持久化失败时回退内存模式，不影响实时指令。
- **短信限流、通讯录自动沉淀**：按设备/手机号限速，同时记录最近联系号码供控制台快捷选择。
- **Cloudflare Assets 托管前端**：无需额外站点即可提供受控的短信操作界面。

---

## 🏗️ 架构概览

```
浏览器 (sms-reply.html)
      │ 1. POST /auth + access code
      │ 2. Cookie: SESSION=...
      │ 3. WebSocket /ws 订阅 device topics
      │ 4. REST /devices /contacts
      ▼
Cloudflare Worker (src/index.js)
      │ 路由 /auth /ws /devices /contacts + 静态资源
      │ 将 WebSocket & REST 请求转发给 Durable Object
      ▼
Durable Object: PubSubBroker (src/broker.js)
      │ 负责 WebSocket fan-out、SQLite、限流
      │ 公开命令 topic: air780e/command/<deviceId>
      │ 监听状态 + 联系人上报
      ▼
Air780E (scripts/*.lua)
      │ util_wss.lua 连接 wss://.../ws?device=XXX&dtoken=YYY
      │ 接收 send_sms / REBOOT 等 command
      │ 上报 status/contact
```

---

## 📦 组成部分
- **`src/index.js`**：Worker 入口、鉴权、静态资源代理、将 WS/HTTP 委托给 Durable Object。
- **`src/broker.js`**：`PubSubBroker` DO，本地 MQTT 式中枢 + SQLite。
- **`public/`**：短信控制台（HTML + JS）。
- **`scripts/`**：运行在 Air780E 的 Lua 脚本（`main.lua`、`util_wss.lua`、`config.lua` 等）。
- **`generate-token.js`**：辅助生成长期凭证的 Node 工具。

---

## ✅ 前置条件
- Node.js **18+**
- `npm` / `pnpm` / `yarn`
- Cloudflare 帐号 + **Wrangler 4.x**
- 已启用 Durable Objects（`PubSubBroker`）
- Air780E 固件（LuaTask）可联网

安装依赖：

```bash
npm install
```

> `generate-token.js` 需要 `dotenv` 与 `jose`；如果没安装请运行 `npm install dotenv jose`.

---

## 🔐 运行所需配置

| 环境变量 | 是否必填 | 说明 |
| --- | --- | --- |
| `VALID_CODES` | ✅ | 浏览器授权码，逗号分隔。在 `/auth` 校验，通过后颁发 10 分钟 SESSION。 |
| `SESSION_SECRET` | ✅ | 用于 HMAC 签名 SESSION Cookie 的随机字符串。 |
| `DEVICE_TOKENS` | ✅ | 允许接入的设备列表，格式 `dev001:tokenA,dev002:tokenB`。Lua 端通过 WSS URL 带 `device`/`dtoken`。 |
| `SMS_LIMIT_PER_DEVICE` | ⛔️ | 每窗口单设备最大发送条数，默认 10。 |
| `SMS_LIMIT_PER_NUMBER` | ⛔️ | 每窗口单号码最大发送条数，默认 5。 |
| `SMS_WINDOW_SECONDS` | ⛔️ | 限流窗口大小（秒），默认 600。 |
| `JWT_MASTER_SECRET` | ⛔️ | 仅当使用 `generate-token.js` 生成 JWT 时需要，Base64 编码。 |

将这些变量写入 `wrangler.toml/wrangler.jsonc` 的 `vars` 或使用 `npx wrangler secret put ...`。本地开发可在 `.dev.vars` 中设置：

```
VALID_CODES=demo123,ops456
SESSION_SECRET=dev-only-secret
DEVICE_TOKENS=dev001:abc123,dev002:def456
SMS_LIMIT_PER_DEVICE=10
SMS_LIMIT_PER_NUMBER=5
SMS_WINDOW_SECONDS=600
```

---

## 🧪 本地开发
1. 登录 Cloudflare：`npx wrangler login`
2. 启动 DevServer：`npm run dev`
3. 浏览器访问 `http://127.0.0.1:8787/sms-reply.html`
4. 首次访问按提示输入访问码（`VALID_CODES`）。
5. 授权成功后可刷新设备、查看联系人并在首次发送短信时建立 WebSocket。

> DevServer 同样会使用 Durable Object，建议在 Cloudflare 控制台确认该 namespace 已创建。

---

## 🚀 部署
```bash
npx wrangler login              # 如尚未登录
npx wrangler deploy             # 推送 Worker + DO schema/迁移
```

`wrangler.jsonc` 关键配置示例：

```jsonc
{
  "name": "air-broker",
  "main": "src/index.js",
  "compatibility_date": "2025-11-11",
  "durable_objects": {
    "bindings": [{ "name": "PUBSUB_BROKER", "class_name": "PubSubBroker" }]
  },
  "migrations": [
    { "tag": "v5", "new_sqlite_classes": ["PubSubBroker"] }
  ],
  "assets": { "directory": "./public" }
}
```

---

## 🔑 鉴权流程

### 浏览器
1. 用户访问 `/sms-reply.html`。
2. JS 向 `/devices` 请求，若收到 401 会弹窗输入访问码。
3. `POST /auth {code}` → 校验 `VALID_CODES`。
4. 通过后返回 `SESSION` Cookie（HttpOnly/Secure/SameSite=Strict，10 分钟有效，并绑定发起 IP）。
5. 之后访问 `/devices` `/contacts` `/ws` 均依赖该 Cookie。

### 设备
1. Air780E 读取 `config.lua` 中的 `WSS_URL`、`DEVICE_ID`、`DEVICE_TOKEN`。
2. `util_wss.lua` 拼成 `wss://worker/ws?device=<id>&dtoken=<token>`。
3. Worker 端 `verifyDeviceToken` 校验 `DEVICE_TOKENS` 列表。
4. 通过后即可订阅 `air780e/command/<device>` 并向 `air780e/status|contact|response` 发布。

---

## 🌐 API & Topic 一览

| 入口 | 方法 | 说明 |
| --- | --- | --- |
| `/auth` | POST | 请求体 `{code}`，校验访问码并发放 SESSION。 |
| `/ws` | GET (Upgrade) | WebSocket。设备通过 query；浏览器需 SESSION Cookie。消息格式 `{action:"subscribe"|"publish", topic, payload}`。 |
| `/devices` | GET | 返回 DO SQLite / 内存中的设备状态列表。 |
| `/contacts` 或 `/contacts/:device` | GET | 查询某设备的最近联系人。 |
| 静态资源 | GET | 来自 `public/`，无需授权（但 JS 会在需要数据时触发 /auth）。 |

**约定 Topic：**
- `air780e/command/<deviceId>`：浏览器 → 设备。`payload.command="send_sms"` 时包含 `to`、`content`、`req_id`。
- `air780e/response/<deviceId>`：设备 → 浏览器。用于回执短信发送状态。
- `air780e/status`：设备定期上报在线/离线状态。
- `air780e/contact`：设备上报最近通讯录条目（用于前端联想）。

---

## 📉 短信限流
- `smsLimitPerDevice`、`smsLimitPerNumber`、`smsWindowSeconds` 可通过环境变量配置。
- 限流逻辑发生在 DO，当发现上限后：
  - 会截断 `send_sms` 指令。
  - 立即向 `air780e/response/<device>` 推送 fail 消息，提示是设备限流还是号码限流。
- 窗口结束时自动清零；无需存储外部状态。

---

## 🖥️ Web 控制台
- 首页自动拉取设备表格，展示在线状态/最后在线时间。
- 点击某设备后可加载该设备的最近联系人列表（点击填充号码）。
- 首次点击“发送短信”才会真正建立 WebSocket，并自动订阅对应的 `response` topic。
- 回执在界面右下角徽章和日志区域提示。

所有逻辑均在 `public/sms-console.js`，如需自定义 UI，可在该文件的 REST/WS 调用基础上调整。

---

## 📡 Air780E 固件脚本
- `scripts/config.lua`：集中管理设备 ID、WSS/MQTT 地址、通知渠道等，可通过 `secrets.lua` 覆盖敏感信息。
- `scripts/util_wss.lua`：与 Worker 通信的核心，负责：
  - 按需拼接 `?device=...&dtoken=...`
  - 订阅命令 topic，执行 `send_sms` 或其他指令
  - 定时上报在线状态、联系人
  - 自动重连、断电下线
- 其他脚本（`util_mobile.lua`, `util_notify.lua` 等）提供通知、位置、短信等扩展功能，可按需裁剪。

部署步骤（示意）：
1. 在 `scripts/secrets.lua` 中填入 `DEVICE_ID`、`DEVICE_TOKEN`、`WSS_URL`。
2. 使用 LuatOS IDE 将 `scripts/` 整体烧录到 Air780E。
3. 设备联网后即可出现在 `/devices` 列表，在线状态应为 green。

---

## 🔧 设备 JWT（可选）
虽然当前 Worker 通过 `DEVICE_TOKENS` 校验 Query Token，但仍提供 `generate-token.js` 便于扩展为 JWT 方案：

```bash
echo "JWT_MASTER_SECRET=base64-encoded-secret" > .env
node generate-token.js 185 2001
```

脚本会为每个设备打印一个有效期到 2035-01-01 的 HS256 JWT，便于后续切换到 Bearer Token 或其它服务中重用。

---

## 📂 项目结构

```
air-broker/
├─ src/
│  ├─ index.js          # Worker 入口：路由、鉴权、静态资源
│  └─ broker.js         # Durable Object：Pub/Sub + SQLite + 限流
├─ public/
│  ├─ sms-reply.html    # 浏览器端界面
│  └─ sms-console.js    # 控制台逻辑
├─ scripts/             # Air780E Lua 脚本
├─ generate-token.js    # 生成设备 JWT 工具
├─ wrangler.jsonc       # Wrangler 配置
├─ package.json
└─ test.js              # 本地调试脚本
```

---

## ❓ 常见问题
- **/devices 返回 401？** 确认 `VALID_CODES` 已配置，并已在当前浏览器输入正确访问码。
- **WebSocket 立即被断开？** 检查 `DEVICE_TOKENS` 是否包含当前设备以及浏览器是否带 SESSION Cookie。
- **短信指令无回执？** 确认 Lua 端 `util_wss.lua` 中 `TOPIC_RESPONSE` 与 Worker 保持一致，并确保限流未触发。
- **SQLite 报错 fallback 到内存？** 查看 Cloudflare Dashboard 是否允许 DO 使用 SQLite（Beta 功能），或在日志中确认错误信息。

---

## 📜 License

MIT License © 2025 dagow

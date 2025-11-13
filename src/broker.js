// src/broker.js
// ✅ Cloudflare SQLite Durable Object 版 PubSubBroker
// - 正确使用 storage.sql.exec(query, ...bindings)
// - 设备 / 通讯录 存储
// - WebSocket publish/subscribe
// - 每日清理旧联系人
// - 短信限流：按设备 + 按手机号，窗口可配置

export class PubSubBroker {
  constructor(state, env) {
    this.state = state;
    this.env = env;

    // 活跃 WebSocket 会话：{ ws, subs:Set<string> }
    this.sessions = [];

    // SQLite 句柄：
    //   undefined = 尚未尝试初始化
    //   null      = 初始化失败（退回内存模式）
    //   object    = 正常可用
    this.sql = undefined;

    // 内存降级存储（当 this.sql === null 时使用）
    this.memDevices = new Map();           // device_id -> { status, last_seen, meta }
    this.memContacts = new Map();          // device_id -> Map(number -> { name, last_seen })

    // 闹钟
    this._alarmReady = false;

    // ====== 短信限流配置（环境变量） ======
    this.smsLimitPerDevice = Number(env.SMS_LIMIT_PER_DEVICE || 10);
    this.smsLimitPerNumber = Number(env.SMS_LIMIT_PER_NUMBER || 5);
    this.smsWindowSeconds  = Number(env.SMS_WINDOW_SECONDS || 600); // 默认 10 分钟窗口

    // 限流窗口内的计数
    this._smsWindowStart = 0;             // ms 时间戳
    this._smsPerDevice   = new Map();     // device_id -> count
    this._smsPerNumber   = new Map();     // phone -> count
  }

  // ============================================================
  // ✅ 延迟初始化 SQLite（严格按 Cloudflare 文档）
  // ============================================================
  #ensureSql() {
    if (this.sql !== undefined) return;   // 已经尝试过了（可能是 null 或对象）

    const sql = this.state.storage.sql;
    if (!sql) {
      console.warn("[broker] storage.sql not available; fallback to in-memory store");
      this.sql = null;
      return;
    }

    try {
      // 多条语句可以一次 exec；无参数绑定
      sql.exec(`
        CREATE TABLE IF NOT EXISTS devices (
          device_id TEXT PRIMARY KEY,
          status    TEXT NOT NULL DEFAULT 'offline',
          last_seen INTEGER NOT NULL DEFAULT 0,
          meta      TEXT
        );
      `);

      sql.exec(`
        CREATE TABLE IF NOT EXISTS contacts (
          device_id TEXT NOT NULL,
          number    TEXT NOT NULL,
          name      TEXT,
          last_seen INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (device_id, number)
        );
      `);

      sql.exec(`
        CREATE INDEX IF NOT EXISTS idx_contacts_device
        ON contacts(device_id, last_seen DESC);
      `);

      this.sql = sql;
      console.log("✅ SQLite schema ensured");
    } catch (e) {
      console.warn("[broker] init sql failed, fallback to memory:", e.message);
      this.sql = null;
    }
  }

  // ============================================================
  // 🕒 清理过期联系人（每天一次）
  // ============================================================
  #cleanupExpiredContacts() {
    const cutoff = Math.floor(Date.now() / 1000) - 86400; // 24h 前

    if (this.sql) {
      try {
        // ⚠️ 注意：参数绑定是 *可变参数*，不是数组
        this.sql.exec(
          `DELETE FROM contacts WHERE last_seen < ?`,
          cutoff
        );
      } catch (e) {
        console.warn("[broker] cleanup sql failed:", e.message);
      }
    } else {
      // 内存模式
      for (const [dev, book] of this.memContacts) {
        for (const [num, rec] of book) {
          if ((rec.last_seen ?? 0) < cutoff) book.delete(num);
        }
        if (book.size === 0) this.memContacts.delete(dev);
      }
    }
  }

  async #scheduleNextCleanup(baseTsMs = Date.now()) {
    const next = new Date(baseTsMs + 24 * 60 * 60 * 1000);
    await this.state.storage.setAlarm(next);
  }

  async #ensureAlarm() {
    if (this._alarmReady) return;
    const existing = await this.state.storage.getAlarm();
    if (!existing) {
      await this.state.storage.setAlarm(new Date(Date.now() + 60 * 1000));
    }
    this._alarmReady = true;
  }

  async alarm() {
    try {
      this.#ensureSql();
      this.#cleanupExpiredContacts();
    } finally {
      await this.#scheduleNextCleanup();
    }
  }

  // ============================================================
  // 🌐 主入口
  // ============================================================
  async fetch(request) {
    this.#ensureSql();
    await this.#ensureAlarm();

    const url = new URL(request.url);
    const { pathname } = url;
    const upgrade = request.headers.get("Upgrade");
    const isWS = upgrade && upgrade.toLowerCase() === "websocket";

    // 1️⃣ WebSocket 连接：转成 session
    if (isWS && pathname === "/ws") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.#handleSession(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    // 2️⃣ REST: /devices
    if (request.method === "GET" && pathname === "/devices") {
      if (this.sql) {
        try {
          // exec 返回 cursor（Iterable），而不是 {results:[]}
          const cursor = this.sql.exec(
            `SELECT device_id, status, last_seen, meta
               FROM devices
              ORDER BY device_id`
          );
          const rows = Array.from(cursor);  // 每行是 { device_id, status, ... }

          return json(rows.map(r => ({
            device_id: r.device_id,
            status:    r.status,
            last_seen: r.last_seen,
            meta:      safeParse(r.meta)
          })));
        } catch (e) {
          console.warn("[/devices] sql error:", e.message);
          // fallthrough 到内存模式
        }
      }

      // 内存模式
      const out = [];
      for (const [id, v] of this.memDevices) {
        out.push({
          device_id: id,
          status:    v.status,
          last_seen: v.last_seen,
          meta:      v.meta ?? null,
        });
      }
      out.sort((a, b) => a.device_id.localeCompare(b.device_id));
      return json(out);
    }

    // 3️⃣ REST: /contacts?device=xxx 或 /contacts/xxx
    if (request.method === "GET" &&
        (pathname === "/contacts" || pathname.startsWith("/contacts/"))) {

      let dev = url.searchParams.get("device");
      if (!dev && pathname.startsWith("/contacts/")) {
        dev = decodeURIComponent(pathname.slice("/contacts/".length));
      }
      if (!dev) return new Response("device required", { status: 400 });

      if (this.sql) {
        try {
          const cursor = this.sql.exec(
            `SELECT number, name, last_seen
               FROM contacts
              WHERE device_id = ?
              ORDER BY last_seen DESC, number ASC`,
            dev
          );
          const rows = Array.from(cursor);
          return json(rows);
        } catch (e) {
          console.warn("[/contacts] sql error:", e.message);
          // fallthrough 到内存模式
        }
      }

      const book = this.memContacts.get(dev);
      if (!book) return json([]);
      const arr = [];
      for (const [num, rec] of book) {
        arr.push({
          number:    num,
          name:      rec.name ?? null,
          last_seen: rec.last_seen ?? 0,
        });
      }
      arr.sort(
        (a, b) =>
          (b.last_seen - a.last_seen) ||
          String(a.number).localeCompare(String(b.number))
      );
      return json(arr);
    }

    return new Response("Not Found", { status: 404 });
  }

  // ============================================================
  // 🔌 WebSocket 逻辑
  // ============================================================
  #handleSession(ws) {
    ws.accept();
    this.#ensureSql();

    const session = { ws, subs: new Set() };
    this.sessions.push(session);

    ws.addEventListener("message", (ev) => {
      try {
        this.#onMessage(session, ev.data);
      } catch (e) {
        console.warn("[ws] onMessage error:", e.message);
      }
    });

    const cleanup = () => {
      this.sessions = this.sessions.filter(s => s !== session);
    };
    ws.addEventListener("close", cleanup);
    ws.addEventListener("error", cleanup);
  }

  #onMessage(session, raw) {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }

    // ---- 订阅 ----
    if (data.action === "subscribe" && typeof data.topic === "string") {
      session.subs.add(data.topic);
      return;
    }

    // ---- 发布 ----
    if (data.action === "publish") {
      const topic   = data.topic || "";
      const payload = data.payload || {};

      // ============= 短信限流：发送命令侧（air780e/command/<dev>) ============
      const mCmd = topic.match(/^air780e\/command\/(.+)$/);
      if (mCmd && payload.command === "send_sms" && payload.to) {
        const devId = mCmd[1];
        const to    = String(payload.to);
        const rl = this.#checkAndIncSms(devId, to);
        if (!rl.ok) {
          const respTopic = `air780e/response/${devId}`;
          const resp = {
            action: "publish",
            topic:  respTopic,
            payload: {
              status:  "fail",
              message: rl.reason === "device-limit"
                ? "该设备短信次数已达上限"
                : "该目标号码短信次数已达上限",
            },
          };
          const respJson = JSON.stringify(resp);
          for (const s of this.sessions) {
            if (s.subs.has(respTopic)) {
              try { s.ws.send(respJson); } catch {}
            }
          }
          // ❌ 不再向设备转发这个 send_sms 命令
          return;
        }
      }

      // ============= 设备状态上报 =============
      if (topic === "air780e/status") {
        const { device_id, status, timestamp } = payload;
        if (device_id && (status === "online" || status === "offline")) {
          try {
            this.#upsertDevice(device_id, status, toInt(timestamp));
          } catch (e) {
            console.warn("[upsertDevice] error:", e.message);
          }
        }
      }

      // ============= 联系人上报 =============
      if (topic === "air780e/contact") {
        const { device_id, number, name, timestamp } = payload;
        if (device_id && number) {
          try {
            this.#upsertContact(
              device_id,
              String(number),
              name || null,
              toInt(timestamp)
            );
          } catch (e) {
            console.warn("[upsertContact] error:", e.message);
          }
        }
      }

      // ============= 扇出给订阅者 =============
      const out = JSON.stringify(data);
      for (const s of this.sessions) {
        if (s.subs.has(topic)) {
          try { s.ws.send(out); } catch {}
        }
      }
    }
  }

  // ============================================================
  // 🧩 短信限流（内存级）
  // ============================================================
  #checkAndIncSms(deviceId, number) {
    const now = Date.now();
    const windowMs = this.smsWindowSeconds * 1000;

    if (!this._smsWindowStart || now - this._smsWindowStart > windowMs) {
      // 重置窗口
      this._smsWindowStart = now;
      this._smsPerDevice = new Map();
      this._smsPerNumber = new Map();
    }

    const devCount = this._smsPerDevice.get(deviceId) || 0;
    const numCount = this._smsPerNumber.get(number)   || 0;

    if (devCount >= this.smsLimitPerDevice) {
      return { ok: false, reason: "device-limit" };
    }
    if (numCount >= this.smsLimitPerNumber) {
      return { ok: false, reason: "number-limit" };
    }

    this._smsPerDevice.set(deviceId, devCount + 1);
    this._smsPerNumber.set(number,   numCount + 1);
    return { ok: true };
  }

  // ============================================================
  // 🧩 数据库操作封装（含内存降级）
  // ============================================================
  #upsertDevice(device_id, status, ts) {
    const now = ts || Math.floor(Date.now() / 1000);

    if (this.sql) {
      // ⚠️ exec(query, ...bindings) —— 不是 exec(query, [bindings])
      this.sql.exec(
        `INSERT INTO devices(device_id, status, last_seen)
           VALUES (?, ?, ?)
           ON CONFLICT(device_id) DO UPDATE SET
             status = excluded.status,
             last_seen = excluded.last_seen`,
        device_id,
        status,
        now
      );
    } else {
      const prev = this.memDevices.get(device_id) || {};
      this.memDevices.set(device_id, {
        status,
        last_seen: now,
        meta: prev.meta ?? null,
      });
    }
  }

  #upsertContact(device_id, number, name, ts) {
    const now = ts || Math.floor(Date.now() / 1000);

    if (this.sql) {
      this.sql.exec(
        `INSERT INTO contacts(device_id, number, name, last_seen)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(device_id, number) DO UPDATE SET
             name      = COALESCE(excluded.name, contacts.name),
             last_seen = MAX(contacts.last_seen, excluded.last_seen)`,
        device_id,
        number,
        name,
        now
      );
    } else {
      let book = this.memContacts.get(device_id);
      if (!book) {
        book = new Map();
        this.memContacts.set(device_id, book);
      }
      const prev = book.get(number) || {};
      book.set(number, {
        name: name ?? prev.name ?? null,
        last_seen: Math.max(prev.last_seen ?? 0, now),
      });
    }
  }
}

// ============================================================
// 🧩 工具函数
// ============================================================
function json(obj) {
  return new Response(JSON.stringify(obj), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function safeParse(s) {
  try { return s ? JSON.parse(s) : null; } catch { return null; }
}

function toInt(x) {
  const n = Number(x);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}
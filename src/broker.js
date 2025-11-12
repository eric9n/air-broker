// src/broker.js
// ✅ 稳定版（可直接覆盖）：
// - SQLite 正确用法：exec(sql, ...bindings) + cursor.toArray()/one()
// - SQL 不可用时自动降级到内存 Map，不影响 WS/REST
// - 订阅 publish/subscribe；记录设备在线，断开自动 offline
// - /devices、/contacts 同时支持 SQL 与内存读写
// - 每日清理过期联系人（< 24h）

export class PubSubBroker {
  constructor(state, env) {
    this.state = state;
    this.env = env;

    // 活跃会话：{ ws, subs:Set<string>, deviceId?:string }
    this.sessions = [];

    // SQLite 句柄（可用时才赋值）
    this.sql = null;
    this.sqlBroken = false; // 一旦 true，后续永久走内存，避免抖动

    // 内存兜底
    this.memDevices = new Map();   // device_id -> { status, last_seen, meta }
    this.memContacts = new Map();  // device_id -> Map<number -> { name, last_seen }>

    this._alarmReady = false;
  }

  // ============================================================
  // SQLite 初始化（不可用则保持 null，不抛错）
  // ============================================================
  #ensureSql() {
    if (this.sqlBroken) { this.sql = null; return; }
    if (this.sql !== null) return; // 已尝试

    const sql = this.state.storage.sql;
    if (!sql) {
      console.warn("[broker] storage.sql not available; fallback to memory");
      this.sql = null;
      return;
    }
    try {
      // 文档要求：逐条执行；绑定只对最后一条起效，所以建表不用绑定
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
      this.sqlBroken = true;
    }
  }

  // ============================================================
  // 每日清理
  // ============================================================
  #cleanupExpiredContacts() {
    const cutoff = Math.floor(Date.now() / 1000) - 86400;

    if (this.sql && !this.sqlBroken) {
      try {
        this.sql.exec("DELETE FROM contacts WHERE last_seen < ?", cutoff);
        return;
      } catch (e) {
        console.warn("[broker] cleanup sql failed:", e.message);
      }
    }
    // 内存清理
    for (const [dev, book] of this.memContacts) {
      for (const [num, rec] of book) {
        if ((rec.last_seen ?? 0) < cutoff) book.delete(num);
      }
      if (book.size === 0) this.memContacts.delete(dev);
    }
  }

  async #scheduleNextCleanup(baseTsMs = Date.now()) {
    const next = new Date(baseTsMs + 24 * 60 * 60 * 1000);
    await this.state.storage.setAlarm(next);
  }
  async #ensureAlarm() {
    if (this._alarmReady) return;
    const existing = await this.state.storage.getAlarm();
    if (!existing) await this.state.storage.setAlarm(new Date(Date.now() + 60 * 1000));
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
  // 路由入口
  // ============================================================
  async fetch(request) {
    this.#ensureSql();
    await this.#ensureAlarm();

    const url = new URL(request.url);
    const upgrade = request.headers.get("Upgrade");

    // 1) WebSocket
    if (upgrade && upgrade.toLowerCase() === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.#handleSession(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    // 2) REST
    const { pathname } = url;

    // /devices
    if (request.method === "GET" && pathname === "/devices") {
      if (this.sql && !this.sqlBroken) {
        try {
          const rows = this.sql
            .exec("SELECT device_id, status, last_seen, meta FROM devices ORDER BY device_id")
            .toArray();
          return json(rows.map(r => ({
            device_id: r.device_id,
            status:    r.status,
            last_seen: r.last_seen,
            meta:      safeParse(r.meta),
          })));
        } catch (e) {
          console.warn("[/devices] sql error:", e.message);
        }
      }
      // 内存兜底
      const out = [];
      for (const [id, v] of this.memDevices) {
        out.push({ device_id: id, status: v.status, last_seen: v.last_seen, meta: v.meta ?? null });
      }
      out.sort((a,b)=> a.device_id.localeCompare(b.device_id));
      return json(out);
    }

    // /contacts 或 /contacts/<device>
    if (request.method === "GET" && (pathname === "/contacts" || pathname.startsWith("/contacts/"))) {
      let dev = url.searchParams.get("device");
      if (!dev && pathname.startsWith("/contacts/")) {
        dev = decodeURIComponent(pathname.substring("/contacts/".length));
      }
      if (!dev) return new Response("device required", { status: 400 });

      if (this.sql && !this.sqlBroken) {
        try {
          const rows = this.sql
            .exec(
              "SELECT number, name, last_seen FROM contacts WHERE device_id = ? ORDER BY last_seen DESC, number ASC",
              dev
            )
            .toArray();
          return json(rows);
        } catch (e) {
          console.warn("[/contacts] sql error:", e.message);
        }
      }
      // 内存兜底
      const book = this.memContacts.get(dev);
      if (!book) return json([]);
      const arr = [];
      for (const [num, rec] of book) {
        arr.push({ number: num, name: rec.name ?? null, last_seen: rec.last_seen ?? 0 });
      }
      arr.sort((a,b)=> (b.last_seen - a.last_seen) || String(a.number).localeCompare(String(b.number)));
      return json(arr);
    }

    return new Response("Not Found", { status: 404 });
  }

  // ============================================================
  // WebSocket
  // ============================================================
  #handleSession(ws) {
    ws.accept();
    this.#ensureSql();

    const session = { ws, subs: new Set(), deviceId: undefined };
    this.sessions.push(session);

    ws.addEventListener("message", (ev) => {
      try {
        const raw = typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data);
        this.#onMessage(session, raw);
      } catch (e) {
        console.warn("[ws] onMessage error:", e.message);
      }
    });

    const cleanup = () => {
      if (session.deviceId) {
        try {
          this.#upsertDevice(session.deviceId, "offline", Math.floor(Date.now()/1000));
        } catch (e) {
          console.warn("[ws] mark offline error:", e.message);
        }
      }
      this.sessions = this.sessions.filter(s => s !== session);
    };
    ws.addEventListener("close", cleanup);
    ws.addEventListener("error", cleanup);
  }

  #onMessage(session, raw) {
    let data;
    try { data = JSON.parse(raw); } catch { return; }

    // subscribe
    if (data.action === "subscribe" && typeof data.topic === "string") {
      session.subs.add(data.topic);
      return;
    }

    // publish
    if (data.action === "publish") {
      const topic = data.topic || "";
      const payload = data.payload || {};

      // 设备状态上报
      if (topic === "air780e/status") {
        const { device_id, status, timestamp } = payload;
        if (device_id && (status === "online" || status === "offline")) {
          try {
            this.#upsertDevice(device_id, status, toInt(timestamp));
            if (status === "online") session.deviceId = device_id;
          } catch (e) {
            console.warn("[upsertDevice] error:", e.message);
          }
        }
      }

      // 联系人上报
      if (topic === "air780e/contact") {
        const { device_id, number, name, timestamp } = payload;
        if (device_id && number) {
          try {
            this.#upsertContact(device_id, String(number), name || null, toInt(timestamp));
            if (!session.deviceId) session.deviceId = device_id;
          } catch (e) {
            console.warn("[upsertContact] error:", e.message);
          }
        }
      }

      // 扇出
      const out = JSON.stringify(data);
      for (const s of this.sessions) {
        if (s.subs.has(topic)) {
          try { s.ws.send(out); } catch { /* ignore single send error */ }
        }
      }
    }
  }

  // ============================================================
  // 数据存取（含内存兜底）
  // ============================================================
  #upsertDevice(device_id, status, ts) {
    const now = ts || Math.floor(Date.now() / 1000);

    if (this.sql && !this.sqlBroken) {
      try {
        this.sql.exec(
          `INSERT INTO devices(device_id, status, last_seen)
           VALUES (?, ?, ?)
           ON CONFLICT(device_id) DO UPDATE SET
             status    = excluded.status,
             last_seen = excluded.last_seen`,
          device_id, status, now
        );
        return;
      } catch (e) {
        console.warn("[upsertDevice/sql] fallback to memory:", e.message);
      }
    }

    const prev = this.memDevices.get(device_id) || {};
    this.memDevices.set(device_id, { status, last_seen: now, meta: prev.meta ?? null });
  }

  #upsertContact(device_id, number, name, ts) {
    const now = ts || Math.floor(Date.now() / 1000);

    if (this.sql && !this.sqlBroken) {
      try {
        this.sql.exec(
          `INSERT INTO contacts(device_id, number, name, last_seen)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(device_id, number) DO UPDATE SET
             name      = COALESCE(excluded.name, contacts.name),
             last_seen = MAX(contacts.last_seen, excluded.last_seen)`,
          device_id, number, name, now
        );
        return;
      } catch (e) {
        console.warn("[upsertContact/sql] fallback to memory:", e.message);
      }
    }

    let book = this.memContacts.get(device_id);
    if (!book) { book = new Map(); this.memContacts.set(device_id, book); }
    const prev = book.get(number) || {};
    book.set(number, { name: name ?? prev.name ?? null, last_seen: Math.max(prev.last_seen ?? 0, now) });
  }
}

// ============================================================
// 工具函数
// ============================================================
function json(obj) {
  return new Response(JSON.stringify(obj), {
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}
function safeParse(s) {
  try { return s ? JSON.parse(s) : null; } catch { return null; }
}
function toInt(x) {
  const n = Number(x);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}
// src/index.js
import { PubSubBroker } from "./broker.js";

// ================================
// 工具：HMAC 签名会话 token（用于浏览器 SESSION）
// ================================
async function importSessionKey(secret) {
  const raw = new TextEncoder().encode(secret);
  return crypto.subtle.importKey(
    "raw",
    raw,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

async function signSession(payloadObj, key) {
  const json = JSON.stringify(payloadObj);
  const data = new TextEncoder().encode(json);
  const sigBytes = await crypto.subtle.sign("HMAC", key, data);
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sigBytes)));
  const payloadB64 = btoa(json);
  // 结构: payload.sig
  return `${payloadB64}.${sigB64}`;
}

async function verifySessionToken(token, key) {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, sigB64] = parts;

  let json;
  try {
    json = atob(payloadB64);
  } catch {
    return null;
  }
  const data = new TextEncoder().encode(json);
  const sigBytes = Uint8Array.from(atob(sigB64), (c) => c.charCodeAt(0));

  const ok = await crypto.subtle.verify("HMAC", key, sigBytes, data);
  if (!ok) return null;

  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function parseCookie(request, name) {
  const cookie = request.headers.get("Cookie") || "";
  const pattern = new RegExp("(?:^|;\\s*)" + name + "=([^;]+)");
  const m = cookie.match(pattern);
  return m ? decodeURIComponent(m[1]) : "";
}

// ================================
// 浏览器 SESSION 校验：10 分钟 + IP 绑定
// ================================
async function requireSession(request, env) {
  const token = parseCookie(request, "SESSION");
  if (!token) return { ok: false, reason: "no-cookie" };

  const secret = env.SESSION_SECRET || "dev-secret";
  const key = await importSessionKey(secret);
  const payload = await verifySessionToken(token, key);
  if (!payload) return { ok: false, reason: "bad-token" };

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < now) {
    return { ok: false, reason: "expired" };
  }

  const reqIp = request.headers.get("CF-Connecting-IP") || "";
  if (payload.ip && payload.ip !== reqIp) {
    return { ok: false, reason: "ip-mismatch" };
  }

  return { ok: true, session: payload };
}

// ================================
// 设备 Token 校验：/ws?device=dev001&dtoken=aaa
// DEVICE_TOKENS 形如: "dev001:aaa,dev002:bbb"
// ================================
function verifyDeviceToken(url, env) {
  const devId = url.searchParams.get("device");
  const tok = url.searchParams.get("dtoken");
  if (!devId || !tok) return { ok: false };

  const map = Object.create(null);
  (env.DEVICE_TOKENS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .forEach((pair) => {
      const [id, t] = pair.split(":");
      if (id && t) map[id] = t;
    });

  if (map[devId] && map[devId] === tok) {
    return { ok: true, deviceId: devId };
  }
  return { ok: false };
}

// ================================
// Worker 入口
// ================================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const upgrade = request.headers.get("Upgrade");
    const isWS = upgrade && upgrade.toLowerCase() === "websocket";

    // Durable Object stub
    const id = env.PUBSUB_BROKER.idFromName("main");
    const stub = env.PUBSUB_BROKER.get(id);

    // ------------------------------------------------
    // 0️⃣ /auth：输入 code，创建 SESSION cookie（10 分钟 + IP 绑定）
    // ------------------------------------------------
    if (pathname === "/auth" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const code = (body.code || "").trim();

      const validCodes = (env.VALID_CODES || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      if (!validCodes.includes(code)) {
        return new Response(JSON.stringify({ ok: false }), {
          status: 401,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }

      const ip = request.headers.get("CF-Connecting-IP") || "";
      const now = Math.floor(Date.now() / 1000);
      const ttl = 600; // 10 分钟
      const payload = {
        sid: crypto.randomUUID(),
        ip,
        iat: now,
        exp: now + ttl,
      };

      const key = await importSessionKey(env.SESSION_SECRET || "dev-secret");
      const token = await signSession(payload, key);

      const cookie = [
        `SESSION=${encodeURIComponent(token)}`,
        "Path=/",
        "HttpOnly",
        "Secure",
        "SameSite=Strict",
        `Max-Age=${ttl}`,
      ].join("; ");

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "Set-Cookie": cookie,
        },
      });
    }

    // ------------------------------------------------
    // 1️⃣ WebSocket：支持两种身份
    //   - 设备：/ws?device=dev001&dtoken=aaa （DEVICE_TOKENS）
    //   - 浏览器：带 SESSION cookie
    // ------------------------------------------------
    if (pathname === "/ws" && isWS) {
      // 先判断是不是“设备连接”
      const devAuth = verifyDeviceToken(url, env);
      if (!devAuth.ok) {
        // 不是设备，则按浏览器走 SESSION 认证
        const auth = await requireSession(request, env);
        if (!auth.ok) {
          return new Response("Unauthorized", { status: 401 });
        }
      }
      // ✅ 设备或浏览器都通过了认证，转发握手给 DO
      return stub.fetch(request);
    }

    // ------------------------------------------------
    // 2️⃣ REST 接口：设备 & 通讯录（只允许浏览器 / 有 SESSION）
    // ------------------------------------------------
    if (
      pathname === "/devices" ||
      pathname.startsWith("/devices/") ||
      pathname === "/contacts" ||
      pathname.startsWith("/contacts/")
    ) {
      const auth = await requireSession(request, env);
      if (!auth.ok) {
        return new Response("Unauthorized", { status: 401 });
      }
      return stub.fetch(request);
    }

    // ------------------------------------------------
    // 3️⃣ 静态资源（页面 + js），不需要 SESSION
    //    前端会在第一次访问时弹出 /auth code 输入
    // ------------------------------------------------
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response("Not Found", { status: 404 });
  },
};

// DO 导出
export { PubSubBroker };
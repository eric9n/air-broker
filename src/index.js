// src/index.js
import { PubSubBroker } from "./broker.js";
import { SignJWT, jwtVerify } from "jose";

// ============================================================
// 🧩 JWT 辅助函数
// ============================================================
async function importHmacKeyFromB64(b64) {
  const keyBytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "raw", keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false, ["sign", "verify"]
  );
}

function pickJwtFromRequest(req) {
  const h = req.headers.get("Authorization");
  if (h?.startsWith("Bearer ")) return h.slice(7);
  const url = new URL(req.url);
  return url.searchParams.get("token") || "";
}

// ============================================================
// 🧩 Worker 入口
// ============================================================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const upgrade = request.headers.get("Upgrade");
    const isWS = upgrade && upgrade.toLowerCase() === "websocket";

    // 每次都取同一个 Durable Object
    const id = env.PUBSUB_BROKER.idFromName("main");
    const stub = env.PUBSUB_BROKER.get(id);

    // ============================================================
    // 1️⃣ /token 端点：生成 JWT（受 Cloudflare Access 保护）
    // ============================================================
    if (url.pathname === "/token" && request.method === "GET") {
      if (!env.JWT_MASTER_SECRET)
        return new Response("Server missing JWT_MASTER_SECRET", { status: 500 });

      const key = await importHmacKeyFromB64(env.JWT_MASTER_SECRET);
      const aud = env.JWT_AUD || "air780e";
      const iss = env.JWT_ISS || "cf-gateway";
      const ttl = Math.max(60, Number(env.JWT_TTL || 300)); // 秒
      const now = Math.floor(Date.now() / 1000);

      const jwt = await new SignJWT({ role: "app" })
        .setProtectedHeader({ alg: "HS256", typ: "JWT" })
        .setIssuer(iss)
        .setAudience(aud)
        .setSubject("app:browser")
        .setIssuedAt(now)
        .setExpirationTime(now + ttl)
        .sign(key);

      return new Response(JSON.stringify({ token: jwt, exp: now + ttl }), {
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    // ============================================================
    // 2️⃣ /ws：WebSocket 握手 + JWT 校验 + 转发到 DO
    // ============================================================
    if (url.pathname === "/ws" && isWS) {
      console.log("HIT /ws", request.method, request.headers.get("Upgrade"));
      if (!env.JWT_MASTER_SECRET)
        return new Response("Server missing JWT_MASTER_SECRET", { status: 500 });

      const token = pickJwtFromRequest(request);
      if (!token)
        return new Response("Unauthorized: missing token", { status: 401 });

      try {
        const key = await importHmacKeyFromB64(env.JWT_MASTER_SECRET);
        await jwtVerify(token, key, {
          audience: env.JWT_AUD || "air780e",
          issuer: env.JWT_ISS || "cf-gateway",
        });
      } catch (err) {
        console.warn("JWT verification failed:", err.message);
        return new Response("Unauthorized: invalid token", { status: 401 });
      }

      // ✅ 转发握手请求给 Durable Object
      // （不要 new Request()，直接传递原 request 更安全）
      return stub.fetch(request);
    }

    // ============================================================
    // 3️⃣ REST 接口：设备 / 联系人
    // ============================================================
    if (
      url.pathname === "/devices" ||
      url.pathname.startsWith("/devices/") ||
      url.pathname === "/contacts" ||
      url.pathname.startsWith("/contacts/")
    ) {
      return stub.fetch(request);
    }

    // ============================================================
    // 4️⃣ 默认 404
    // ============================================================
    return new Response("Not Found", { status: 404 });
  },
};

// DO 类导出给 wrangler
export { PubSubBroker };
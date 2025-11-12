import { PubSubBroker } from "./broker.js";
import { jwtVerify, SignJWT } from "jose";

export { PubSubBroker };

// -------------------- 工具函数 --------------------

// base64 → Uint8Array
function decodeBase64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// 从请求中提取 JWT（优先 Header，再查 ?jwt=）
function extractJwt(request) {
  const url = new URL(request.url);
  const authHeader = request.headers.get("Authorization");
  if (authHeader && authHeader.startsWith("Bearer ")) {
    return authHeader.substring(7);
  }
  const q = url.searchParams.get("jwt");
  if (q && q.length > 0) return q;
  return null;
}

const resJSON = (obj, init = {}) =>
  new Response(JSON.stringify(obj), {
    status: init.status || 200,
    headers: {
      "content-type": "application/json",
      ...(init.headers || {}),
    },
  });
const res401 = (msg = "Unauthorized") => new Response(msg, { status: 401 });
const res404 = () => new Response("Not found", { status: 404 });

// -------------------- Worker 主体 --------------------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // 1️⃣ /token — 网页端获取短期 JWT
    if (pathname === "/token") {
      if (!env.JWT_MASTER_SECRET) {
        return new Response("Server misconfigured: JWT_MASTER_SECRET missing", { status: 500 });
      }

      // 可选：加一个简单的同源保护（如果使用 Access，可移除）
      const origin = request.headers.get("origin") || "";
      const host = url.host;
      if (origin && !origin.endsWith(host)) return res401("forbidden origin");

      const aud = env.JWT_AUD || "air780e";
      const iss = env.JWT_ISS || "cf-gateway";
      const ttlSec = parseInt(env.JWT_TTL || "300", 10); // 默认 5 分钟有效

      const secretBytes = decodeBase64ToBytes(env.JWT_MASTER_SECRET);
      const now = Math.floor(Date.now() / 1000);
      const exp = now + ttlSec;

      // 签发短期 token
      const jwt = await new SignJWT({ typ: "browser", scope: "wss:connect" })
        .setProtectedHeader({ alg: "HS256", typ: "JWT" })
        .setIssuer(iss)
        .setAudience(aud)
        .setIssuedAt(now)
        .setExpirationTime(exp)
        .sign(secretBytes);

      const headers = {
        "access-control-allow-origin": `https://${host}`,
        "access-control-allow-credentials": "true",
      };
      return resJSON({ token: jwt, exp }, { headers });
    }

    // 2️⃣ /ws — 校验 JWT 并转发至 Durable Object
    if (pathname === "/ws") {
      if (!env.JWT_MASTER_SECRET) {
        return new Response("Server misconfigured: JWT_MASTER_SECRET missing", { status: 500 });
      }

      const token = extractJwt(request);
      if (!token) return res401("Unauthorized: missing token");

      try {
        const secretBytes = decodeBase64ToBytes(env.JWT_MASTER_SECRET);
        const aud = env.JWT_AUD || "air780e";
        const iss = env.JWT_ISS || "cf-gateway";

        // 校验 JWT
        const { payload } = await jwtVerify(token, secretBytes, { issuer: iss, audience: aud });

        // ✅ 可选：白名单校验设备身份（sub）
        const allowList = ["device:185", "device:186"]; // 你可用 KV 维护
        if (payload.typ === "device" && !allowList.includes(payload.sub)) {
          return res401("Unauthorized: device not allowed");
        }

        console.log("✅ JWT OK:", payload);

        // 转发给 Durable Object
        const doBinding = env.PUBSUB_BROKER;
        const doId = doBinding.idFromName("main-broker");
        const doStub = doBinding.get(doId);
        return doStub.fetch(request);

      } catch (err) {
        console.error("JWT verify failed:", err?.message || err);
        return res401("Unauthorized: invalid token");
      }
    }

    // 3️⃣ 默认
    return res404();
  },
};
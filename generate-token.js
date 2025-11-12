// generate-token.js
import "dotenv/config"; // ✅ 自动加载 .env 文件
import { SignJWT } from "jose";

// 1️⃣ 从 .env 读取密钥
const b64 = process.env.JWT_MASTER_SECRET;
if (!b64) {
  console.error("❌ 缺少环境变量 JWT_MASTER_SECRET，请在 .env 文件中设置。");
  console.error("示例: JWT_MASTER_SECRET=你的Base64密钥");
  process.exit(1);
}

// 2️⃣ 解析 Base64
let secret;
try {
  secret = Uint8Array.from(Buffer.from(b64, "base64"));
} catch (err) {
  console.error("❌ 无法解析 JWT_MASTER_SECRET，请确认是 Base64 编码:", err.message);
  process.exit(1);
}

// 3️⃣ 读取命令行参数（设备编号）
const deviceArgs = process.argv.slice(2);
if (deviceArgs.length === 0) {
  console.error("❌ 请输入至少一个设备编号，例如:");
  console.error("   node generate-token.js 185 186 187");
  process.exit(1);
}

// 4️⃣ 设置长期有效期（2035-01-01）
const exp = Math.floor(new Date("2035-01-01T00:00:00Z").getTime() / 1000);

// 5️⃣ 为每个设备生成 JWT 并直接打印到控制台
for (const id of deviceArgs) {
  const jwt = await new SignJWT({
    typ: "device",
    scope: "wss:connect",
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer("cf-gateway")
    .setAudience("air780e")
    .setSubject(`device:${id}`)
    .setExpirationTime(exp)
    .sign(secret);

  console.log(`\n=== 设备 ${id} ===`);
  console.log(jwt);
}
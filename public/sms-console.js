// sms-console.js
(async function () {
  const statusEl = document.getElementById("status");
  const logEl = document.getElementById("log");
  const deviceSel = document.getElementById("deviceSelect");
  const devicesTbl = document.querySelector("#devicesTable tbody");
  const devicesInfo = document.getElementById("devicesInfo");
  const refreshDev = document.getElementById("refreshDevicesBtn");

  const contactsTbl = document.querySelector("#contactsTable tbody");
  const contactsInfo = document.getElementById("contactsInfo");
  const refreshCt = document.getElementById("refreshContactsBtn");

  const toEl = document.getElementById("to");
  const contentEl = document.getElementById("content");
  const sendBtn = document.getElementById("sendBtn");
  const clearBtn = document.getElementById("clearBtn");
  const ackEl = document.getElementById("ack");

  function appendLog(msg, color = "#333") {
    const line = document.createElement("div");
    line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    line.style.color = color;
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
  }

  const fmtTime = (ts) => {
    if (!ts) return "-";
    const ms = ts > 1e12 ? ts : ts * 1000;
    return new Date(ms).toLocaleString();
  };

  const statusDot = (s) =>
    `<span class="status-dot ${s === "online" ? "online" : "offline"}"></span>${
      s || "-"
    }`;

  // ==========================================================
  // 1️⃣ 授权逻辑：用访问码换 cookie（只负责 /auth）
  // ==========================================================
  let authReady = false;

  async function ensureAuth() {
    if (authReady) return true;

    const code = window.prompt("请输入访问码：");
    if (!code) {
      appendLog("未输入访问码，已取消", "red");
      statusEl.textContent = "❌ 未输入访问码，部分功能不可用";
      return false;
    }

    try {
      const r = await fetch("/auth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
        credentials: "include",
      });

      if (!r.ok) {
        appendLog("访问码验证失败", "red");
        statusEl.textContent = "❌ 访问码错误，请刷新页面重试";
        alert("访问码错误或未通过，请重试");
        return false;
      }

      const data = await r.json().catch(() => ({}));
      if (data.ok) {
        authReady = true;
        appendLog("✅ 访问码验证通过", "green");
        statusEl.textContent = "✅ 已授权，可加载设备列表";
        return true;
      } else {
        appendLog("访问码验证失败", "red");
        statusEl.textContent = "❌ 访问码错误，请刷新页面重试";
        alert("访问码错误，请重试");
        return false;
      }
    } catch (e) {
      appendLog("访问码验证异常: " + e.message, "red");
      statusEl.textContent = "❌ 访问码验证异常，请稍后再试";
      alert("访问码验证异常，请稍后再试");
      return false;
    }
  }

  // ==========================================================
  // 2️⃣ WebSocket：只负责连接，不再弹 code
  //    ✅ 修正：openWSOnce 等待真正 onopen 后再 resolve
  // ==========================================================
  let ws = null;
  let wsAttempted = false;
  let wsReadyPromise = null; // 用来等待连接完成
  const subscribed = new Set();

  function subscribeResponseTopic(devId) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const topic = `air780e/response/${devId}`;
    if (subscribed.has(topic)) return;
    subscribed.add(topic);
    ws.send(JSON.stringify({ action: "subscribe", topic }));
    appendLog(`📡 订阅回执: ${topic}`);
  }

  async function openWSOnce() {
    // 已经是 OPEN，直接返回
    if (ws && ws.readyState === WebSocket.OPEN) return ws;

    // 已经在连接中或之前触发过连接：复用 Promise
    if (wsReadyPromise) return wsReadyPromise;

    wsAttempted = true;
    statusEl.textContent = "🔌 正在连接 WebSocket...";

    wsReadyPromise = new Promise((resolve) => {
      const wsUrl = `wss://${location.host}/ws`;
      const socket = new WebSocket(wsUrl);
      ws = socket;

      const cleanup = () => {
        // 连接结果已确定，允许后面再次重试（如果你想禁止重试，可以不清 wsReadyPromise）
        wsReadyPromise = null;
      };

      socket.addEventListener("open", () => {
        statusEl.textContent = "✅ WebSocket 已连接";
        appendLog("WebSocket 已连接", "green");
        sendBtn.disabled = false;
        if (deviceSel.value) subscribeResponseTopic(deviceSel.value);
        cleanup();
        resolve(socket);
      });

      socket.addEventListener("message", (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.action === "publish" && typeof msg.topic === "string") {
            if (msg.topic.startsWith("air780e/response/")) {
              const p = msg.payload || {};
              const st = (p.status || "").toLowerCase();
              const ok = st === "success";
              ackEl.textContent = ok ? "已送达" : p.message || "发送失败";
              ackEl.className = "badge " + (ok ? "ok" : "fail");
              ackEl.style.display = "inline-block";
              appendLog(
                `📥 回执: ${JSON.stringify(p)}`,
                ok ? "#0f7a3e" : "#b42318"
              );
            } else {
              appendLog(`WS: ${e.data}`);
            }
          } else {
            appendLog(`WS: ${e.data}`);
          }
        } catch {
          appendLog("WS: " + e.data);
        }
      });

      const markClosed = (reason) => {
        sendBtn.disabled = true;
        statusEl.textContent = `⚠️ WebSocket 已关闭（${reason || "断开"}），可稍后刷新重连`;
        appendLog(`WebSocket 已关闭：${reason || ""}`, "red");
      };

      socket.addEventListener("close", (ev) => {
        markClosed(`code=${ev.code}`);
        cleanup();
        // 如果还没 resolve（极端情况连接很快就关闭），这里确保返回 null
        resolve(null);
      });

      socket.addEventListener("error", () => {
        markClosed("发生错误");
        cleanup();
        resolve(null);
      });
    });

    return wsReadyPromise;
  }

  // ==========================================================
  // 3️⃣ 加载设备列表：遇到 401 时触发授权
  // ==========================================================
  async function fetchDevices() {
    devicesTbl.innerHTML = "";
    devicesInfo.textContent = "加载中…";
    statusEl.textContent = "📡 正在加载设备列表…";

    try {
      let r = await fetch("/devices", { credentials: "include" });
      if (r.status === 401) {
        const ok = await ensureAuth();
        if (!ok) {
          devicesInfo.textContent = "未授权";
          statusEl.textContent = "❌ 未授权，设备列表不可用";
          return;
        }
        r = await fetch("/devices", { credentials: "include" });
      }
      if (!r.ok) throw new Error(r.statusText);

      const list = await r.json();
      devicesInfo.textContent = `共 ${list.length} 台`;
      deviceSel.innerHTML = "";

      list.forEach((d, i) => {
        const opt = document.createElement("option");
        opt.value = d.device_id;
        opt.textContent = `${d.device_id} (${d.status || "-"})`;
        if (i === 0) opt.selected = true;
        deviceSel.appendChild(opt);

        const tr = document.createElement("tr");
        tr.className = "clickable";
        tr.innerHTML = `<td>${d.device_id}</td><td>${statusDot(
          d.status
        )}</td><td>${fmtTime(d.last_seen)}</td>`;
        tr.addEventListener("click", () => {
          deviceSel.value = d.device_id;
          fetchContacts();
          subscribeResponseTopic(d.device_id);
        });
        devicesTbl.appendChild(tr);
      });

      if (list.length) {
        await fetchContacts();
        statusEl.textContent =
          "✅ 设备列表已加载（发送短信时将自动连接 WebSocket）";
      } else {
        contactsTbl.innerHTML = "";
        contactsInfo.textContent = "无设备";
        statusEl.textContent = "✅ 无设备记录";
      }
    } catch (e) {
      devicesInfo.textContent = "加载失败";
      statusEl.textContent = "❌ 加载设备失败，请稍后重试";
      appendLog("加载设备失败: " + e.message, "red");
    }
  }

  refreshDev.addEventListener("click", fetchDevices);
  deviceSel.addEventListener("change", () => {
    fetchContacts();
    subscribeResponseTopic(deviceSel.value);
  });

  // ==========================================================
  // 4️⃣ 加载通讯录（已授权即可）
  // ==========================================================
  async function fetchContacts() {
    contactsTbl.innerHTML = "";
    const dev = deviceSel.value;
    if (!dev) {
      contactsInfo.textContent = "未选择设备";
      return;
    }
    contactsInfo.textContent = "加载中…";
    try {
      let r = await fetch(`/contacts/${encodeURIComponent(dev)}`, {
        credentials: "include",
      });
      if (!r.ok) {
        r = await fetch(`/contacts?device=${encodeURIComponent(dev)}`, {
          credentials: "include",
        });
      }
      if (!r.ok) throw new Error(r.statusText);

      const list = await r.json();
      contactsInfo.textContent = `共 ${list.length} 个`;
      list.forEach((c) => {
        const tr = document.createElement("tr");
        tr.className = "clickable";
        tr.innerHTML = `<td>${c.number}</td><td>${
          c.name || "-"
        }</td><td>${fmtTime(c.last_seen)}</td>`;
        tr.addEventListener("click", () => {
          toEl.value = c.number;
          appendLog(
            `选择联系人: ${c.number}${
              c.name ? "（" + c.name + "）" : ""
            }`
          );
        });
        contactsTbl.appendChild(tr);
      });
    } catch (e) {
      contactsInfo.textContent = "加载失败";
      appendLog("加载通讯录失败: " + e.message, "red");
    }
  }

  refreshCt.addEventListener("click", fetchContacts);

  // ==========================================================
  // 5️⃣ 发送短信（第一次发送时才连 WS，且等待连上）
  // ==========================================================
  const genReqId = () =>
    Math.random().toString(36).slice(2, 10) +
    Date.now().toString(36).slice(-4);

  sendBtn.onclick = async function () {
    const dev = deviceSel.value;
    const to = toEl.value.trim();
    const content = contentEl.value.trim();
    if (!dev || !to || !content) {
      alert("请选择设备并填写手机号与内容");
      return;
    }

    // ⬇️ 关键：等待 openWSOnce 真正连上（或失败）
    const socket = await openWSOnce();
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      appendLog("WebSocket 未连接（请检查授权或网络）", "red");
      alert("连接未就绪，请稍后再试");
      return;
    }

    const req_id = genReqId();
    const msg = {
      action: "publish",
      topic: `air780e/command/${dev}`,
      payload: { command: "send_sms", to, content, req_id },
    };
    socket.send(JSON.stringify(msg));
    ackEl.style.display = "none";
    appendLog(`📤 发送给 ${to}: ${content} (req_id=${req_id})`, "blue");
    contentEl.value = "";
    subscribeResponseTopic(dev);
  };

  clearBtn.onclick = () => {
    toEl.value = "";
    contentEl.value = "";
    ackEl.style.display = "none";
  };

  // ==========================================================
  // 6️⃣ 初始化：先尝试加载设备列表
  // ==========================================================
  statusEl.textContent = "📡 初始化：正在加载设备列表…";
  await fetchDevices();
  // WebSocket 等你第一次点“发送短信”的时候再连
})();
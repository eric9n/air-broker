-- util_wss.lua
-- 依赖全局库：log, json, websocket, sms
-- 需要 require: sys, config
local sys    = require "sys"
local config = require "config"

local M = {}

-- ===== 配置 =====
local WSS_URL         = config.WSS_URL
local JWT_TOKEN       = config.JWT_TOKEN
local DEVICE_ID       = config.DEVICE_ID
local PING_INTERVAL_S = config.PING_INTERVAL_S or 300          -- keepalive 秒
local STATUS_INTERVAL_S = config.STATUS_INTERVAL_S or 300       -- presence 间隔

-- 主题（与服务端 broker.js 约定）
local TOPIC_STATUS   = config.PUB_TOPIC_STATUS or "air780e/status"
local TOPIC_CONTACT  = "air780e/contact"                        -- 临时通讯录上报
local TOPIC_COMMAND  = (config.SUB_TOPIC_BASE or "air780e/command/") .. DEVICE_ID
local TOPIC_RESPONSE = (config.PUB_TOPIC_BASE or "air780e/response/") .. DEVICE_ID

-- 必要配置校验
if not DEVICE_ID or DEVICE_ID == "" then
  log.error("util_wss", "DEVICE_ID 未配置，WSS 客户端不启动")
  return M
end
if not WSS_URL or WSS_URL == "" then
  log.error("util_wss", "WSS_URL 未配置，WSS 客户端不启动")
  return M
end

-- ===== 内部状态 =====
local ws           -- WebSocket client 实例
local status_timer -- 在线心跳定时器

-- ===== 工具：发送 JSON publish =====
local function send_message(cli, topic, payload)
  if not cli or not cli.ready or not cli:ready() then
    log.warn("util_wss", "ws 未就绪，丢弃:", topic)
    return false
  end
  local ok, body = pcall(json.encode, {
    action  = "publish",
    topic   = topic,
    payload = payload
  })
  if not ok then
    log.error("util_wss", "JSON 编码失败:", body)
    return false
  end
  return cli:send(body)
end

-- ===== 对外：通用发布 =====
function M.publish(topic, payload)
  return send_message(ws, topic, payload)
end

-- ===== 对外：上报联系人（写入服务端 SQLite：contacts 表）=====
-- number: 必填；name/ts 可选；ts 为秒
function M.report_contact(number, name, ts)
  if not number or tostring(number) == "" then
    log.warn("util_wss", "report_contact: 无效号码")
    return false
  end
  return send_message(ws, TOPIC_CONTACT, {
    device_id = DEVICE_ID,
    number    = tostring(number),
    name      = name or nil,
    timestamp = ts or os.time()
  })
end

-- ===== 内部：在线状态心跳 =====
local function send_status(is_online)
  return send_message(ws, TOPIC_STATUS, {
    device_id = DEVICE_ID,
    status    = is_online and "online" or "offline",
    timestamp = os.time()
  })
end

-- ===== WS 回调 =====
local function on_ws_event(cli, event, data, payload)
  if event == "conack" then
    log.info("util_wss", "WSS 连接成功", DEVICE_ID)

    -- 订阅专属命令主题
    local sub = json.encode({ action = "subscribe", topic = TOPIC_COMMAND })
    cli:send(sub)

    -- 上线 & 定时 presence
    if status_timer then sys.timerStop(status_timer) end
    send_status(true)
    status_timer = sys.timerLoopStart(function() send_status(true) end, STATUS_INTERVAL_S * 1000)

  elseif event == "recv" then
    -- 收到服务端下发消息（如：send_sms 指令）
    local ok, msg = pcall(json.decode, data)
    if not ok then
      log.error("util_wss", "消息解析失败:", msg)
      return
    end
    if msg.action == "publish" and msg.topic == TOPIC_COMMAND then
      local p = msg.payload or {}
      if p.command == "send_sms" and p.to and p.content then
        local ok_send = sms.send(p.to, p.content)
        M.publish(TOPIC_RESPONSE, {
          status  = ok_send and "success" or "fail",
          to      = p.to,
          message = ok_send and "SMS sent" or "SMS failed"
        })
        -- 可选：把“对方号码”也记入临时通讯录
        if ok_send then M.report_contact(p.to, nil, os.time()) end
      elseif p.command == "REBOOT" then
        M.notify_shutdown()
        sys.timerStart(rtos.restart, 1000)
      else
        M.publish(TOPIC_RESPONSE, { status = "fail", message = "Unknown command" })
      end
    end

  elseif event == "sent" then
    -- 可忽略
  elseif event == "disconnect" then
    log.warn("util_wss", "WSS 断开")
    if status_timer then sys.timerStop(status_timer) end
    status_timer = nil
  else
    log.warn("util_wss", "未知事件:", event)
  end
end

-- ===== 连接流程 =====
local function connect_broker()
  log.info("util_wss", "连接到", WSS_URL)

  -- 创建 WS：签名 (adapter, url, keepalive_s, use_ipv6)
  ws = websocket.create(nil, WSS_URL, PING_INTERVAL_S, false)
  if not ws then
    log.error("util_wss", "websocket.create 返回 nil")
    return
  end

  -- 注册回调、设置 Header、自动重连、发起连接
  ws:on(on_ws_event)
  ws:headers({ ["Authorization"] = JWT_TOKEN })
  ws:autoreconn(true, 10000) -- 断线 10s 后自动重连
  ws:connect()
end

-- ===== 对外：初始化 =====
function M.init()
  sys.taskInit(function()
    log.info("util_wss", "等待 IP_READY …")
    sys.waitUntil("IP_READY")
    connect_broker()
  end)
end

-- ===== 对外：关机前下线 =====
function M.notify_shutdown()
  log.info("util_wss", "发送 offline")
  send_status(false)
end

return M
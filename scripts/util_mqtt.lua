-- mqtt.lua  (LuatOS-Air / AIR780E / EC618)
-- 依赖: sys, config
-- 使用: 在主程序中 require("mqtt").init()

local sys    = require "sys"
local config = require "config"

local M = {}

----------------------------------------------------
-- 配置
----------------------------------------------------
local DEVICE_ID         = config.DEVICE_ID
local SUB_TOPIC_COMMAND = (config.SUB_TOPIC_BASE   or "air780e/command/")  .. (DEVICE_ID or "")
local PUB_TOPIC_RESPONSE= (config.PUB_TOPIC_BASE   or "air780e/response/") .. (DEVICE_ID or "")
local PUB_TOPIC_STATUS  =  config.PUB_TOPIC_STATUS or "air780e/status"
local STATUS_INTERVAL_S =  config.STATUS_INTERVAL_S or 300

-- MQTT 连接配置
local MQTT_HOST        = config.MQTT_HOST               -- 必填: 主机名 / IP
local MQTT_TLS         = not not config.MQTT_TLS        -- true=TLS(8883), false=TCP(1883)
local MQTT_PORT        = tonumber(config.MQTT_PORT) or (MQTT_TLS and 8883 or 1883)
local MQTT_USER        = config.MQTT_USER or ""         -- 公共 broker 多为空
local MQTT_PASS        = config.MQTT_PASS or ""
local MQTT_KEEPALIVE_S = tonumber(config.MQTT_KEEPALIVE) or 60
local MQTT_CLEAN       = 1                              -- 一般为 1
local MQTT_CLIENT_ID   = config.MQTT_CLIENT_ID
if not MQTT_CLIENT_ID then
    local rand = tostring(os.time()):sub(-5) .. string.format("%04d", math.random(0, 9999))
    MQTT_CLIENT_ID = "air780e-" .. rand
end
-- 发布默认 QoS；如需更改可在 config 中设置
local MQTT_QOS_PUB     = tonumber(config.MQTT_QOS_PUB) or 0
-- 额外订阅（可选）：支持 {"a/b","c/d"} 或 {["a/b"]=0,["c/d"]=1}
local MQTT_SUB_TOPICS  = config.MQTT_SUB_TOPICS

-- 关键配置校验
if not DEVICE_ID or DEVICE_ID == "" then
    log.error("MQTT", "DEVICE_ID 未配置 (config.DEVICE_ID)")
    return M
end
if not MQTT_HOST or MQTT_HOST == "" then
    log.error("MQTT", "MQTT_HOST 未配置 (config.MQTT_HOST)")
    return M
end

----------------------------------------------------
-- 状态
----------------------------------------------------
local cli      -- mqtt 客户端实例
local status_timer

----------------------------------------------------
-- 工具函数
----------------------------------------------------
local function ready()
    return cli and cli:ready()
end

local function publish(topic, payload, qos)
    if not ready() then
        log.warn("MQTT", "未连接，发送失败：", topic)
        return false
    end
    qos = (qos ~= nil) and qos or MQTT_QOS_PUB
    if type(payload) ~= "string" then
        local ok, s = pcall(json.encode, payload)
        if not ok then
            log.error("MQTT", "JSON 编码失败：", s)
            return false
        end
        payload = s
    end
    return cli:publish(topic, payload, qos)
end

local function send_status_beacon(is_online)
    log.info("Presence", "发送状态：", is_online and "ONLINE" or "OFFLINE")
    local payload = {
        device_id = DEVICE_ID,
        status    = is_online and "online" or "offline",
        timestamp = os.time()
    }
    publish(PUB_TOPIC_STATUS, payload)
end

local function subscribe_all()
    -- 固定订阅：命令主题
    local subs = { [SUB_TOPIC_COMMAND] = 0 }

    -- 可选订阅：用户自定义
    if type(MQTT_SUB_TOPICS) == "table" then
        for k, v in pairs(MQTT_SUB_TOPICS) do
            if type(k) == "string" then
                subs[k] = tonumber(v) or 0
            elseif type(v) == "string" then
                subs[v] = 0
            end
        end
    end
    cli:subscribe(subs)
end

----------------------------------------------------
-- 回调
----------------------------------------------------
local function on_mqtt(cli0, event, data, payload)
    if event == "conack" then
        log.info("MQTT", "连接成功", MQTT_HOST .. ":" .. MQTT_PORT, MQTT_TLS and "TLS" or "TCP")
        -- 订阅
        subscribe_all()
        -- Presence 心跳
        if status_timer then sys.timerStop(status_timer) end
        send_status_beacon(true)
        status_timer = sys.timerLoopStart(function()
            send_status_beacon(true)
        end, STATUS_INTERVAL_S * 1000)

    elseif event == "recv" then
        local topic = data
        local text
        if type(payload) == "string" then
            text = payload
        elseif payload and payload.toStr then
            text = payload:toStr()
        end
        log.info("MQTT", "消息", topic, text and #text or 0)

        -- 只处理命令主题
        if topic == SUB_TOPIC_COMMAND and text and text ~= "" then
            local ok, msg = pcall(json.decode, text)
            if not ok then
                log.error("MQTT", "JSON 解析失败：", msg)
                return
            end
            local p = msg and msg.payload
            if p and p.command == "send_sms" then
                if p.to and p.content then
                    local result = sms.send(p.to, p.content)
                    local status_msg = result and ("SMS 成功发送给: " .. p.to) or ("SMS 发送失败: " .. p.to)
                    log.info("MQTT", status_msg)
                    publish(PUB_TOPIC_RESPONSE, {
                        status = result and "success" or "fail",
                        to = p.to, message = status_msg
                    })
                else
                    publish(PUB_TOPIC_RESPONSE, { status="fail", message="Invalid command, 'to' or 'content' missing" })
                end
            elseif p and p.command == "REBOOT" then
                log.info("MQTT", "收到 REBOOT，准备重启")
                M.notify_shutdown()
                sys.timerStart(rtos.restart, 1000)
            else
                publish(PUB_TOPIC_RESPONSE, { status="fail", message="Unknown command" })
            end
        end

    elseif event == "sent" then
        -- 可选：日志
        -- log.debug("MQTT", "已发送")

    elseif event == "disconnect" then
        log.warn("MQTT", "已断开")
        if status_timer then sys.timerStop(status_timer) end
        status_timer = nil
        -- 不做手动重连，交给 autoreconn

    else
        log.warn("MQTT", "未知事件:", event)
    end
end

----------------------------------------------------
-- 连接
----------------------------------------------------
local function connect_broker()
    log.info("MQTT", "连接到", MQTT_HOST, MQTT_PORT, MQTT_TLS and "TLS" or "TCP")

    cli = mqtt.create(nil, MQTT_HOST, MQTT_PORT, MQTT_CLEAN, MQTT_TLS)
    if not cli then
        log.error("MQTT", "mqtt.create() 失败")
        return
    end

    if MQTT_USER ~= "" or MQTT_PASS ~= "" then
        cli:auth(MQTT_USER, MQTT_PASS)
    end

    cli:keepalive(MQTT_KEEPALIVE_S)
    cli:autoreconn(true, 10000)     -- 10 秒自动重连
    cli:on(on_mqtt)
    cli:connect(MQTT_CLIENT_ID)     -- 发起连接
end

----------------------------------------------------
-- 公共接口
----------------------------------------------------
function M.init()
    if not DEVICE_ID or DEVICE_ID == "" or not MQTT_HOST or MQTT_HOST == "" then
        log.error("MQTT", "init 失败：DEVICE_ID 或 MQTT_HOST 未设置")
        return
    end

    sys.taskInit(function()
        log.info("MQTT", "等待 IP_READY（最多 10 分钟）...")
        local ok = sys.waitUntil("IP_READY", 10*60*1000)
        if not ok then
            log.error("MQTT", "等待 IP_READY 超时")
            return
        end
        connect_broker()
    end)
end

function M.notify_shutdown()
    log.info("MQTT", "发送 Offline 遗言")
    if ready() then
        send_status_beacon(false)
    end
end

return M
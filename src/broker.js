// (这是您 DO 的代码: src/broker.js)

// PubSubBroker 是我们服务的“大脑”
// Cloudflare 会为我们运行这个类，并保持它的状态
export class PubSubBroker {
    constructor(state, env) {
      this.state = state;
      this.sessions = []; // 存储所有“存活”的 WebSocket 连接
      this.topics = new Map(); // 存储 Topic 和订阅了它的 Session
    }
  
    // 这是 Worker (index.js) 调用 DO 时的主入口
    async fetch(request) {
      // 检查请求是否要求升级到 WebSocket
      const upgradeHeader = request.headers.get("Upgrade");
      if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
        return new Response("只接受 WebSocket (WSS) 连接", { status: 426 });
      }
  
      // 创建一对 WebSocket，一个给客户端，一个给 DO (服务器端)
      const [client, server] = new WebSocketPair();
  
      // 告诉 DO 开始处理这个新的 "server" WebSocket
      this.handleSession(server);
  
      // 返回 "client" WebSocket 给用户，完成连接升级
      return new Response(null, {
        status: 101, // 101 Switching Protocols
        webSocket: client,
      });
    }
  
    // (私有) 处理一个新的 WebSocket 会话
    handleSession(webSocket) {
      webSocket.accept(); // 接受这个连接
  
      // 创建一个会话对象，用来跟踪它的订阅
      const session = {
        webSocket: webSocket,
        subscriptions: new Set(),
      };
      this.sessions.push(session); // 将其加入“存活”列表
  
      // 3. 设置消息处理器
      webSocket.onmessage = (msg) => {
        this.handleMessage(session, msg.data);
      };
  
      // 4. 设置关闭处理器
      webSocket.onclose = () => {
        console.log("Session closed");
        this.handleClose(session);
      };
  
      // 5. 设置错误处理器
      webSocket.onerror = (err) => {
        console.error("Session error:", err);
        this.handleClose(session);
      };
    }
  
    // (私有) 处理来自客户端的 JSON 消息
    handleMessage(session, message) {
      let data;
      try {
        data = JSON.parse(message);
      } catch (err) {
        console.error("无法解析的 JSON:", message);
        return;
      }
  
      console.log("收到消息:", data);
  
      // --- 这是核心的 Pub/Sub 逻辑 ---
  
      if (data.action === "subscribe") {
        // 1. 订阅
        console.log(`会话订阅了: ${data.topic}`);
        session.subscriptions.add(data.topic);
  
      } else if (data.action === "publish") {
        // 2. 发布 (扇出)
        console.log(`收到发布到 ${data.topic} 的消息`);
        
        // 准备要广播的消息 (我们把完整的 publish 消息转发出去)
        const outgoingMessage = JSON.stringify(data);
  
        // 遍历所有“存活”的会话
        this.sessions.forEach(s => {
          // 检查这个会话是否订阅了这个 topic
          if (s.subscriptions.has(data.topic)) {
            try {
              // 发送消息!
              s.webSocket.send(outgoingMessage);
            } catch (err) {
              // 如果发送失败 (例如连接已死)，就清理掉它
              console.error("发送失败, 清理会话:", err);
              this.handleClose(s);
            }
          }
        });
      }
    }
  
    // (私有) 处理一个会话的关闭
    handleClose(session) {
      // 从“存活”列表中移除
      this.sessions = this.sessions.filter(s => s !== session);
    }
  }
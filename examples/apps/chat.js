// Chat room: WebSocket hibernation API + history in SQL.
//   GET /ws?name=alice  (WebSocket) → receives {type:"history"}, then {type:"msg"} broadcasts;
//                                     send any text to post it
//   GET /history        → last 50 messages
import { DurableObject } from "cloudflare:workers";

export class App extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, text TEXT, at INTEGER)",
    );
  }

  history() {
    return this.ctx.storage.sql
      .exec("SELECT name, text, at FROM (SELECT * FROM messages ORDER BY id DESC LIMIT 50) ORDER BY at")
      .toArray();
  }

  async fetch(req) {
    const url = new URL(req.url);
    if (req.headers.get("upgrade") === "websocket") {
      const { 0: client, 1: server } = new WebSocketPair();
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ name: url.searchParams.get("name") ?? "anon" });
      server.send(JSON.stringify({ type: "history", messages: this.history() }));
      return new Response(null, { status: 101, webSocket: client });
    }
    if (url.pathname === "/history") return Response.json({ messages: this.history() });
    return new Response("connect a WebSocket to /ws?name=you", { status: 426 });
  }

  webSocketMessage(ws, text) {
    const { name } = ws.deserializeAttachment();
    const msg = { name, text: String(text).slice(0, 500), at: Date.now() };
    this.ctx.storage.sql.exec("INSERT INTO messages (name, text, at) VALUES (?, ?, ?)", msg.name, msg.text, msg.at);
    const frame = JSON.stringify({ type: "msg", ...msg });
    for (const peer of this.ctx.getWebSockets()) peer.send(frame);
  }

  webSocketClose(ws, code) {
    ws.close(code === 1005 || code === 1006 ? 1000 : code);
  }
}

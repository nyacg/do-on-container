import { DurableObject } from "cloudflare:workers";

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS hits (id INTEGER PRIMARY KEY, at INTEGER)");
    this.big = null;
  }
  async fetch(req) {
    const url = new URL(req.url);
    if (req.headers.get("upgrade") === "websocket") {
      const [c, s] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(s);
      return new Response(null, { status: 101, webSocket: c });
    }
    if (url.pathname.endsWith("/touch")) {
      this.ctx.storage.sql.exec("INSERT INTO hits (at) VALUES (?)", Date.now());
      const n = this.ctx.storage.sql.exec("SELECT count(*) AS n FROM hits").one().n;
      return Response.json({ n });
    }
    if (url.pathname.endsWith("/dump")) {
      const tables = this.ctx.storage.sql.exec("SELECT type, name, sql FROM sqlite_master").toArray();
      await this.ctx.storage.put("kvkey", { a: 1 });
      const kv = [...(await this.ctx.storage.list())];
      return Response.json({ tables, kv });
    }
    if (url.pathname.endsWith("/alarm")) {
      await this.ctx.storage.setAlarm(Date.now() + 500);
      return new Response("set");
    }
    if (url.pathname.endsWith("/alarmed")) {
      return Response.json({ fired: (await this.ctx.storage.get("alarmFired")) ?? null });
    }
    return new Response("ok");
  }
  async alarm() { await this.ctx.storage.put("alarmFired", Date.now()); }
  webSocketMessage(ws, msg) {
    if (msg === "ping") return ws.send("pong");
    if (msg.startsWith("echo:")) return ws.send(msg);
    for (const p of this.ctx.getWebSockets()) if (p !== ws) p.send(msg);
  }
  webSocketClose(ws, code) { try { ws.close(code); } catch {} }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const m = url.pathname.match(/^\/r\/([^/]+)/);
    if (m) return env.ROOM.get(env.ROOM.idFromName(m[1])).fetch(req);
    if (url.pathname === "/bulk") {
      // touch N DOs: /bulk?from=0&n=1000
      const from = +url.searchParams.get("from") || 0, n = +url.searchParams.get("n") || 100;
      const t0 = Date.now();
      const ps = [];
      for (let i = from; i < from + n; i++) ps.push(env.ROOM.get(env.ROOM.idFromName("d" + i)).fetch("http://x/touch").then(r => r.text()));
      await Promise.all(ps);
      return Response.json({ n, ms: Date.now() - t0 });
    }
    if (url.pathname === "/__cpubench") {
      const t0 = Date.now(); let x = 0;
      for (let i = 0; i < 2e8; i++) x = (x + i * 2654435761) % 4294967296;
      return Response.json({ ms: Date.now() - t0, x });
    }
    if (url.pathname === "/__stats") return env.STATS.fetch("http://stats/proc.json");
    if (url.pathname === "/__pushlog") return env.STATS.fetch("http://stats/push.log");
    if (url.pathname === "/bridge") {
      const t0 = Date.now();
      const r = await fetch("http://bridge.internal/ping?from=container");
      return Response.json({ status: r.status, body: await r.text(), ms: Date.now() - t0 });
    }
    return new Response("router ok");
  },
};

// Reminders: many scheduled jobs on one alarm — the pattern behind agent "schedule()".
//   POST /remind?in=5000&text=stand+up → schedules a reminder
//   GET  /                             → { pending, done }
//   GET  /ws (WebSocket)                → pushes {type:"due", ...} when a reminder fires
import { DurableObject } from "cloudflare:workers";

export class App extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS reminders (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT, due INTEGER, fired INTEGER)",
    );
  }

  list() {
    const all = this.ctx.storage.sql.exec("SELECT id, text, due, fired FROM reminders ORDER BY due").toArray();
    return { pending: all.filter((r) => !r.fired), done: all.filter((r) => r.fired) };
  }

  /** One alarm, always set to the earliest pending reminder. */
  async reschedule() {
    const next = this.ctx.storage.sql.exec("SELECT min(due) AS due FROM reminders WHERE fired IS NULL").one().due;
    if (next === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(next);
  }

  async fetch(req) {
    const url = new URL(req.url);
    if (req.headers.get("upgrade") === "websocket") {
      const { 0: client, 1: server } = new WebSocketPair();
      this.ctx.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }
    if (req.method === "POST" && url.pathname === "/remind") {
      const due = Date.now() + Number(url.searchParams.get("in") ?? 5000);
      this.ctx.storage.sql.exec("INSERT INTO reminders (text, due) VALUES (?, ?)", url.searchParams.get("text") ?? "ping", due);
      await this.reschedule();
    }
    return Response.json(this.list());
  }

  async alarm() {
    const now = Date.now();
    const due = this.ctx.storage.sql.exec("SELECT id, text, due FROM reminders WHERE fired IS NULL AND due <= ?", now).toArray();
    for (const r of due) {
      this.ctx.storage.sql.exec("UPDATE reminders SET fired = ? WHERE id = ?", now, r.id);
      for (const ws of this.ctx.getWebSockets()) ws.send(JSON.stringify({ type: "due", ...r, firedAt: now }));
    }
    await this.reschedule();
  }

  webSocketClose(ws, code) {
    ws.close(code === 1005 || code === 1006 ? 1000 : code);
  }
}

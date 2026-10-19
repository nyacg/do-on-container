// Counter: SQL + an alarm. The smallest useful Durable Object, as dynamic code.
//   GET  /          → { count }
//   POST /inc       → { count }  (increments)
//   POST /reset-in?ms=5000 → schedules a reset with an alarm
import { DurableObject } from "cloudflare:workers";

export class App extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS counter (id INTEGER PRIMARY KEY CHECK (id = 1), n INTEGER NOT NULL)");
    ctx.storage.sql.exec("INSERT OR IGNORE INTO counter VALUES (1, 0)");
  }

  count() {
    return this.ctx.storage.sql.exec("SELECT n FROM counter").one().n;
  }

  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/inc") {
      this.ctx.storage.sql.exec("UPDATE counter SET n = n + 1");
    } else if (req.method === "POST" && url.pathname === "/reset-in") {
      const at = Date.now() + Number(url.searchParams.get("ms") ?? 5000);
      await this.ctx.storage.setAlarm(at);
      return Response.json({ count: this.count(), resetAt: at });
    }
    return Response.json({ count: this.count(), resetAt: await this.ctx.storage.getAlarm() });
  }

  async alarm() {
    this.ctx.storage.sql.exec("UPDATE counter SET n = 0");
  }
}

import { PortableDurableObject, type PoolEnv } from "./portable";

/**
 * Live cursors room.
 *
 * Clients send `{t:"m", x, y}` as often as they like; the server batches positions and
 * broadcasts one frame per 50ms tick containing only what changed. Clicks drop "stamps"
 * that are persisted in SQLite (so they survive restarts/migrations via checkpoints).
 * `{t:"p", ts}` is echoed straight back for RTT measurement.
 *
 * The tick timer keeps the object awake while anyone is connected — which on Cloudflare
 * means it is billed for wall-clock duration the whole time. That's the workload where the
 * pool shines.
 */
interface Attachment {
  id: number;
  color: string;
}

const TICK_MS = 50;
const MAX_STAMPS = 300;
const COLORS = ["#e11d48", "#2563eb", "#16a34a", "#d97706", "#7c3aed", "#0891b2", "#db2777", "#65a30d"];

export class CursorRoom extends PortableDurableObject<PoolEnv> {
  static slug = "cursors";
  private positions = new Map<number, [number, number]>();
  private colors = new Map<number, string>();
  private changed = new Map<number, [number, number] | null>();
  private nextId = 1;
  private timer: ReturnType<typeof setInterval> | undefined;
  private messages = 0;
  private idleTicks = 0;

  protected onStart() {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS stamps (id INTEGER PRIMARY KEY AUTOINCREMENT, x REAL, y REAL, color TEXT, at INTEGER)",
    );
    // Restore state for sockets that survived hibernation.
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (!a) continue;
      this.nextId = Math.max(this.nextId, a.id + 1);
      this.colors.set(a.id, a.color);
    }
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.headers.get("upgrade") !== "websocket") {
      if (url.pathname.endsWith("/info")) return Response.json(this.info());
      return new Response("expected websocket", { status: 426 });
    }
    const { 0: client, 1: server } = new WebSocketPair();
    const a: Attachment = { id: this.nextId++, color: COLORS[Math.floor(Math.random() * COLORS.length)] };
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(a);
    this.colors.set(a.id, a.color);
    const stamps = this.ctx.storage.sql
      .exec("SELECT x, y, color FROM stamps ORDER BY id DESC LIMIT ?", MAX_STAMPS)
      .raw();
    server.send(
      JSON.stringify({
        t: "hello",
        you: a,
        cursors: [...this.positions].map(([id, [x, y]]) => [id, x, y, this.colors.get(id) ?? "#888"]),
        stamps: [...stamps],
        pooled: this.pooled,
      }),
    );
    this.ensureTicking();
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    this.messages++;
    if (typeof raw !== "string") return;
    const msg = JSON.parse(raw);
    const a = ws.deserializeAttachment() as Attachment;
    if (!this.colors.has(a.id)) this.colors.set(a.id, a.color);
    switch (msg.t) {
      case "m":
        this.positions.set(a.id, [msg.x, msg.y]);
        this.changed.set(a.id, [msg.x, msg.y]);
        this.ensureTicking();
        break;
      case "s": {
        this.ctx.storage.sql.exec(
          "INSERT INTO stamps (x, y, color, at) VALUES (?, ?, ?, ?)",
          msg.x,
          msg.y,
          a.color,
          Date.now(),
        );
        this.ctx.storage.sql.exec(
          "DELETE FROM stamps WHERE id <= (SELECT max(id) FROM stamps) - ?",
          MAX_STAMPS,
        );
        this.broadcast(JSON.stringify({ t: "s", x: msg.x, y: msg.y, color: a.color }));
        break;
      }
      case "p":
        ws.send(JSON.stringify({ t: "p", ts: msg.ts }));
        break;
    }
  }

  webSocketClose(ws: WebSocket, code: number) {
    this.leave(ws);
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code);
    } catch {}
  }

  webSocketError(ws: WebSocket) {
    this.leave(ws);
  }

  private leave(ws: WebSocket) {
    const a = ws.deserializeAttachment() as Attachment | null;
    if (!a) return;
    this.positions.delete(a.id);
    this.colors.delete(a.id);
    this.changed.set(a.id, null);
  }

  private ensureTicking() {
    this.idleTicks = 0;
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  private tick() {
    if (this.changed.size === 0) {
      // Nothing moved for a second: stop the timer so an idle room can hibernate.
      if (++this.idleTicks >= 1000 / TICK_MS) {
        clearInterval(this.timer ?? null);
        this.timer = undefined;
      }
      return;
    }
    this.idleTicks = 0;
    const u = [...this.changed].map(([id, p]) => (p ? [id, p[0], p[1], this.colors.get(id) ?? "#888"] : [id]));
    this.changed.clear();
    this.broadcast(JSON.stringify({ t: "c", u }));
  }

  private broadcast(frame: string) {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(frame);
      } catch {}
    }
  }

  private info() {
    const stamps = this.ctx.storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM stamps").one().n;
    return { name: this.doName, pooled: this.pooled, sockets: this.ctx.getWebSockets().length, stamps, messages: this.messages };
  }
}

import { PortableDurableObject, type PoolEnv } from "./portable";

/**
 * Example (bindings): the directory of AI rooms. Rooms call it over a Durable Object binding
 * (`env.LOBBY.getByName("global").update(...)`) whenever people join, leave or talk, and it
 * pushes the room list to everyone watching over a hibernatable WebSocket. Also the global
 * budget for AI replies, so a public demo can't run up a bill.
 *
 *   GET /        rooms, busiest first        GET /ws   live room list
 */
const AI_PER_DAY = 1500;

export type LobbyRoom = {
  name: string;
  users: number;
  last: string;
  at: number;
};

export class Lobby extends PortableDurableObject<PoolEnv> {
  static slug = "lobby";

  protected onStart() {
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS rooms (name TEXT PRIMARY KEY, users INTEGER, last TEXT, at INTEGER, seq INTEGER)");
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS ai_budget (day TEXT PRIMARY KEY, used INTEGER)");
    const cols = this.ctx.storage.sql.exec<{ name: string }>("PRAGMA table_info(rooms)").toArray().map((c) => c.name);
    if (!cols.includes("seq")) this.ctx.storage.sql.exec("ALTER TABLE rooms ADD COLUMN seq INTEGER DEFAULT 0");
    // One-off: before test rooms (t-…) had their own lobby, they and the first smoke tests'
    // rooms were listed here.
    if (this.doName === "global" && !this.ctx.storage.kv.get("cleanup-1")) {
      this.ctx.storage.sql.exec("DELETE FROM rooms WHERE name GLOB 't-*' OR name GLOB 'pp-*' OR name GLOB 'probe-*' OR name GLOB 'demo-mv*'");
      this.ctx.storage.kv.put("cleanup-1", true);
    }
  }

  /**
   * RPC from a room. `seq` orders a room's reports: they're separate calls and can arrive out of
   * order (e.g. "message posted, 1 here" overtaking "left, 0 here"), so older ones are ignored.
   */
  async update(room: string, users: number, last: string | undefined, seq: number): Promise<{ applied: boolean }> {
    const applied = this.ctx.storage.sql.exec(
      `INSERT INTO rooms (name, users, last, at, seq) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET users = excluded.users, last = COALESCE(?, last), at = excluded.at, seq = excluded.seq
       WHERE excluded.seq > COALESCE(rooms.seq, 0)`,
      room, users, last ?? "", Date.now(), seq, last ?? null,
    ).rowsWritten;
    if (!applied) return { applied: false };
    const rooms = this.rooms();
    const frame = JSON.stringify({ type: "rooms", rooms });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(frame);
      } catch {}
    }
    return { applied: true };
  }

  /** RPC from a room before it calls Workers AI: true if today's budget has room. */
  async takeAiBudget(): Promise<{ ok: boolean; used: number; limit: number }> {
    const day = new Date().toISOString().slice(0, 10);
    const used = this.ctx.storage.sql
      .exec<{ used: number }>(
        "INSERT INTO ai_budget (day, used) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET used = used + 1 RETURNING used",
        day,
      )
      .one().used;
    return { ok: used <= AI_PER_DAY, used, limit: AI_PER_DAY };
  }

  rooms(): LobbyRoom[] {
    return this.ctx.storage.sql
      .exec<LobbyRoom>(
        "SELECT name, users, last, at FROM rooms WHERE at > ? ORDER BY users DESC, at DESC LIMIT 30",
        Date.now() - 24 * 3600_000,
      )
      .toArray();
  }

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("upgrade") === "websocket") {
      const { 0: client, 1: server } = new WebSocketPair();
      this.ctx.acceptWebSocket(server);
      server.send(JSON.stringify({ type: "rooms", rooms: this.rooms() }));
      return new Response(null, { status: 101, webSocket: client });
    }
    return Response.json({ rooms: this.rooms(), pooled: this.pooled });
  }

  webSocketMessage() {}

  webSocketClose(ws: WebSocket, code: number) {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code);
    } catch {}
  }
}

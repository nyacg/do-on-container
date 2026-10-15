import { PortableDurableObject, type PoolEnv } from "./portable";

/**
 * The "awake but quiet" workload: a 1 Hz server loop (think game tick, presence sweep,
 * polling an upstream, an agent waiting on an LLM) that pushes a small frame to whoever is
 * connected and persists a counter every 10 ticks.
 *
 * A timer like this keeps a real Durable Object out of hibernation, so it's billed for
 * wall-clock duration around the clock even though it does almost nothing.
 */
const TICK_MS = 1000;

export class Ticker extends PortableDurableObject<PoolEnv> {
  static slug = "ticker";
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticks = 0;

  protected onStart() {
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS counter (id INTEGER PRIMARY KEY CHECK (id = 1), n INTEGER)");
    this.ticks = this.ctx.storage.sql.exec<{ n: number }>("SELECT n FROM counter WHERE id = 1").toArray()[0]?.n ?? 0;
    if (this.ctx.getWebSockets().length) this.start();
  }

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("upgrade") !== "websocket") {
      return Response.json({ name: this.doName, pooled: this.pooled, ticks: this.ticks, sockets: this.ctx.getWebSockets().length });
    }
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    this.start();
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    if (typeof raw === "string" && raw.startsWith('{"t":"p"')) ws.send(raw);
  }

  webSocketClose(ws: WebSocket, code: number) {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code);
    } catch {}
  }

  private start() {
    this.timer ??= setInterval(() => this.tick(), TICK_MS);
  }

  private tick() {
    const sockets = this.ctx.getWebSockets();
    if (!sockets.length) {
      clearInterval(this.timer ?? null);
      this.timer = undefined;
      return;
    }
    this.ticks++;
    if (this.ticks % 10 === 0) {
      this.ctx.storage.sql.exec("INSERT OR REPLACE INTO counter (id, n) VALUES (1, ?)", this.ticks);
    }
    const frame = `{"t":"tick","n":${this.ticks}}`;
    for (const ws of sockets) {
      try {
        ws.send(frame);
      } catch {}
    }
  }
}

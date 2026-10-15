import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { PortableDurableObject, type PoolEnv } from "./portable";

/**
 * Collaborative document speaking the standard y-websocket protocol, so the stock
 * `y-websocket` WebsocketProvider works as the client.
 *
 * Updates are appended to SQLite and compacted into a single snapshot every COMPACT_EVERY
 * updates. Awareness (remote cursors/selections) is relayed statelessly so the object can
 * hibernate on Cloudflare; new joiners trigger a "query awareness" broadcast instead.
 */
const MSG_SYNC = 0;
const MSG_AWARENESS = 1;
const MSG_QUERY_AWARENESS = 3;
const COMPACT_EVERY = 200;

export class YDoc extends PortableDurableObject<PoolEnv> {
  static slug = "doc";
  private doc!: Y.Doc;
  private pending = 0;

  protected onStart() {
    const sql = this.ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS updates (id INTEGER PRIMARY KEY AUTOINCREMENT, data BLOB NOT NULL)");
    this.doc = new Y.Doc({ gc: true });
    const rows = sql.exec<{ data: ArrayBuffer }>("SELECT data FROM updates ORDER BY id").toArray();
    for (const r of rows) Y.applyUpdate(this.doc, new Uint8Array(r.data));
    this.pending = rows.length;
    this.doc.on("update", (update: Uint8Array, origin: unknown) => this.onUpdate(update, origin));
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.headers.get("upgrade") !== "websocket") {
      if (url.pathname.endsWith("/text")) return new Response(this.doc.getText("codemirror").toString());
      if (url.pathname.endsWith("/info")) return Response.json(this.info());
      return new Response("expected websocket", { status: 426 });
    }
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);

    const e = encoding.createEncoder();
    encoding.writeVarUint(e, MSG_SYNC);
    syncProtocol.writeSyncStep1(e, this.doc);
    server.send(encoding.toUint8Array(e));

    // Ask everyone else to re-announce their awareness so the newcomer sees them.
    const q = encoding.createEncoder();
    encoding.writeVarUint(q, MSG_QUERY_AWARENESS);
    this.broadcast(encoding.toUint8Array(q), server);

    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    if (typeof raw === "string") {
      if (raw.startsWith("{")) {
        const msg = JSON.parse(raw);
        if (msg.t === "p") ws.send(JSON.stringify({ t: "p", ts: msg.ts }));
      }
      return;
    }
    const data = new Uint8Array(raw);
    const d = decoding.createDecoder(data);
    const type = decoding.readVarUint(d);
    switch (type) {
      case MSG_SYNC: {
        const e = encoding.createEncoder();
        encoding.writeVarUint(e, MSG_SYNC);
        syncProtocol.readSyncMessage(d, e, this.doc, ws);
        if (encoding.length(e) > 1) ws.send(encoding.toUint8Array(e));
        break;
      }
      case MSG_AWARENESS:
        this.broadcast(data, ws);
        break;
      case MSG_QUERY_AWARENESS:
        this.broadcast(data, ws);
        break;
    }
  }

  webSocketClose(ws: WebSocket, code: number) {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code);
    } catch {}
  }

  private onUpdate(update: Uint8Array, origin: unknown) {
    const sql = this.ctx.storage.sql;
    sql.exec("INSERT INTO updates (data) VALUES (?)", update.slice().buffer);
    if (++this.pending >= COMPACT_EVERY) {
      const state = Y.encodeStateAsUpdate(this.doc);
      this.ctx.storage.transactionSync(() => {
        sql.exec("DELETE FROM updates");
        sql.exec("INSERT INTO updates (data) VALUES (?)", state.slice().buffer);
      });
      this.pending = 1;
    }
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, MSG_SYNC);
    syncProtocol.writeUpdate(e, update);
    this.broadcast(encoding.toUint8Array(e), origin as WebSocket | undefined);
  }

  private broadcast(frame: Uint8Array, except?: WebSocket) {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      try {
        ws.send(frame);
      } catch {}
    }
  }

  private info() {
    return {
      name: this.doName,
      pooled: this.pooled,
      sockets: this.ctx.getWebSockets().length,
      chars: this.doc.getText("codemirror").length,
      updateRows: this.pending,
    };
  }
}

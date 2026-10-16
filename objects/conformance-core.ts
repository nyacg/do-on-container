/**
 * Conformance object: exercises the Durable Object API surface over HTTP + WebSocket so the
 * same assertions (test/parity.test.ts) can run against every backend:
 *   real DO · pooled DO · real DO facet (Dynamic Workers) · pooled facet · sandboxed facet
 *
 * Written as a mixin over a base class so the identical code is used statically
 * (`class Conformance extends withConformance(PortableDurableObject)`) and as a dynamically
 * loaded Worker (`class App extends withConformance(DurableObject)`, bundled into a string).
 */
type Ctor<T = object> = abstract new (...args: any[]) => T;
// `ctx` is protected on DurableObject, so the mixin reaches it through `state` below.
type DOBase = Ctor<any>;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS items (k TEXT PRIMARY KEY, v TEXT);
  CREATE TABLE IF NOT EXISTS alarms_fired (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, scheduled INTEGER, retry_count INTEGER);
  CREATE TABLE IF NOT EXISTS alarm_plan (id INTEGER PRIMARY KEY CHECK (id = 1), fail_times INTEGER, failed INTEGER);
`;

export function withConformance<TBase extends DOBase>(Base: TBase) {
  abstract class ConformanceMixin extends Base {
    private schemaReady = false;

    private get state(): DurableObjectState {
      return (this as any).ctx;
    }

    private db() {
      if (!this.schemaReady) {
        this.state.storage.sql.exec(SCHEMA);
        this.schemaReady = true;
      }
      return this.state.storage.sql;
    }

    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      if (req.headers.get("upgrade") === "websocket") return this.acceptSocket(url);
      const op = url.pathname.split("/").filter(Boolean).slice(-2).join("/");
      const q = Object.fromEntries(url.searchParams);
      try {
        return Response.json(await this.op(op, q));
      } catch (e) {
        return Response.json({ error: String(e) }, { status: 500 });
      }
    }

    private async op(op: string, q: Record<string, string>): Promise<unknown> {
      const sql = this.db();
      const storage = this.state.storage;
      switch (op) {
        case "c/name":
          return { name: this.state.id.name ?? null, id: this.state.id.toString().length };
        // --- SQL
        case "sql/put":
          sql.exec("INSERT OR REPLACE INTO items (k, v) VALUES (?, ?)", q.k, q.v);
          return { ok: true };
        case "sql/get":
          return { v: sql.exec<{ v: string }>("SELECT v FROM items WHERE k = ?", q.k).toArray()[0]?.v ?? null };
        case "sql/count":
          return { n: sql.exec<{ n: number }>("SELECT count(*) AS n FROM items").one().n };
        case "sql/blob": {
          const bytes = new Uint8Array([0, 1, 2, 250, 251, 252]);
          sql.exec("CREATE TABLE IF NOT EXISTS blobs (id INTEGER PRIMARY KEY, b BLOB)");
          sql.exec("INSERT OR REPLACE INTO blobs VALUES (1, ?)", bytes.buffer);
          const back = new Uint8Array(sql.exec<{ b: ArrayBuffer }>("SELECT b FROM blobs WHERE id = 1").one().b);
          return { equal: back.join(",") === bytes.join(",") };
        }
        case "sql/blobget": {
          const r = sql.exec<{ b: ArrayBuffer }>("SELECT b FROM blobs WHERE id = 1").toArray()[0];
          return { bytes: r ? [...new Uint8Array(r.b)] : null };
        }
        case "sql/tx": {
          let threw = "";
          try {
            storage.transactionSync(() => {
              sql.exec("INSERT OR REPLACE INTO items (k, v) VALUES ('tx', 'in-tx')");
              throw new Error("rollback");
            });
          } catch (e) {
            threw = String(e);
          }
          return { threw, v: sql.exec<{ v: string }>("SELECT v FROM items WHERE k = 'tx'").toArray()[0]?.v ?? null };
        }
        // --- sync KV
        case "kv/put":
          storage.kv.put(q.k, JSON.parse(q.v));
          return { ok: true };
        case "kv/get":
          return { v: storage.kv.get(q.k) ?? null };
        case "kv/list":
          return { keys: [...storage.kv.list({ prefix: q.prefix })].map(([k]) => k) };
        case "kv/delete":
          return { deleted: storage.kv.delete(q.k) };
        // --- async storage API
        case "async/put":
          await storage.put(q.k, JSON.parse(q.v));
          return { ok: true };
        case "async/get":
          return { v: (await storage.get(q.k)) ?? null };
        // --- alarms
        case "alarm/set": {
          const at = Date.now() + Number(q.ms ?? 1000);
          sql.exec("INSERT OR REPLACE INTO alarm_plan (id, fail_times, failed) VALUES (1, ?, 0)", Number(q.fail ?? 0));
          await storage.setAlarm(at);
          return { at };
        }
        case "alarm/get":
          return { at: await storage.getAlarm() };
        case "alarm/delete":
          await storage.deleteAlarm();
          return { at: await storage.getAlarm() };
        case "alarm/fired":
          return {
            fired: sql.exec("SELECT at, scheduled, retry_count AS retryCount FROM alarms_fired ORDER BY id").toArray(),
          };
        // --- lifecycle
        case "c/deleteAll":
          await storage.deleteAll();
          this.schemaReady = false;
          return { alarm: await storage.getAlarm(), kv: [...storage.kv.list()].length };
        case "c/sockets":
          return {
            sockets: this.state.getWebSockets().map((ws) => ({ tags: this.state.getTags(ws), att: ws.deserializeAttachment() })),
          };
      }
      return { error: `unknown op ${op}` };
    }

    private acceptSocket(url: URL): Response {
      const { 0: client, 1: server } = new WebSocketPair();
      const tag = url.searchParams.get("tag") ?? "none";
      this.state.acceptWebSocket(server, [tag]);
      server.serializeAttachment({ tag, joined: true });
      return new Response(null, { status: 101, webSocket: client });
    }

    webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer) {
      if (typeof msg !== "string") return ws.send(msg); // binary echo
      if (msg.startsWith("echo:")) return ws.send(msg);
      if (msg === "who") {
        return ws.send(
          JSON.stringify(
            this.state.getWebSockets().map((s) => ({ tags: this.state.getTags(s), att: s.deserializeAttachment() })),
          ),
        );
      }
      if (msg.startsWith("tag:")) {
        for (const s of this.state.getWebSockets(msg.slice(4))) s.send(`to-${msg.slice(4)}`);
        return;
      }
      if (msg.startsWith("all:")) for (const s of this.state.getWebSockets()) s.send(msg);
    }

    webSocketClose(ws: WebSocket, code: number) {
      try {
        ws.close(code === 1005 || code === 1006 ? 1000 : code);
      } catch {}
    }

    async alarm(info?: { retryCount: number; isRetry: boolean }) {
      const sql = this.db();
      const plan = sql.exec<{ fail_times: number; failed: number }>("SELECT fail_times, failed FROM alarm_plan WHERE id = 1").toArray()[0];
      sql.exec(
        "INSERT INTO alarms_fired (at, scheduled, retry_count) VALUES (?, ?, ?)",
        Date.now(),
        0,
        info?.retryCount ?? 0,
      );
      if (plan && plan.failed < plan.fail_times) {
        sql.exec("UPDATE alarm_plan SET failed = failed + 1 WHERE id = 1");
        throw new Error("planned alarm failure");
      }
    }
  }
  return ConformanceMixin;
}

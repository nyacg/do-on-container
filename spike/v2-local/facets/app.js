// Tenant code loaded at runtime via env.LOADER. VERSION is replaced per code id by host.js.
import { DurableObject } from "cloudflare:workers";

const VERSION = "__VERSION__";
const ts = () => new Date().toISOString();

export class App extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.startedAt = Date.now();
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS hits (n INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT, at INTEGER)");
      ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS alarm_runs (n INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT, at INTEGER, retry INTEGER)");
      this.bcw = "ran";
    });
    console.log(`${ts()} [facet construct] v=${VERSION} id.name=${ctx.id.name} id=${ctx.id}`);
  }

  // ---- RPC methods (called by the supervisor through the facet stub) ----
  hello(who) {
    return `hello ${who} from ${VERSION}`;
  }
  info() {
    const s = this.ctx.storage;
    return {
      version: VERSION,
      idName: this.ctx.id.name ?? null,
      id: String(this.ctx.id),
      bcw: this.bcw,
      hits: s.sql.exec("SELECT count(*) c FROM hits").one().c,
      kv: s.kv.get("k") ?? null,
      sqlDbSize: s.sql.databaseSize,
      sockets: this.ctx.getWebSockets().length,
      alarmRuns: s.sql.exec("SELECT * FROM alarm_runs").toArray(),
    };
  }

  async fetch(req) {
    const url = new URL(req.url);
    const s = this.ctx.storage;
    switch (url.pathname) {
      case "/hit":
        s.sql.exec("INSERT INTO hits (v, at) VALUES (?, ?)", VERSION, Date.now());
        return Response.json(this.info());
      case "/kv":
        s.kv.put("k", url.searchParams.get("v") ?? "x");
        return Response.json({ kv: s.kv.get("k") });
      case "/tx": {
        let threw = null;
        try {
          s.transactionSync(() => {
            s.sql.exec("INSERT INTO hits (v, at) VALUES ('tx', 0)");
            throw new Error("rollback me");
          });
        } catch (e) {
          threw = String(e);
        }
        const ok = s.transactionSync(() => {
          s.sql.exec("INSERT INTO hits (v, at) VALUES ('tx-ok', 0)");
          return s.sql.exec("SELECT count(*) c FROM hits WHERE v LIKE 'tx%'").one().c;
        });
        return Response.json({ threw, txRowsAfter: ok });
      }
      case "/alarm": {
        const ms = Number(url.searchParams.get("ms") ?? 3000);
        await s.setAlarm(Date.now() + ms);
        return Response.json({ getAlarm: await s.getAlarm() });
      }
      case "/proxyalarm": {
        // Facets can't use ctx.storage.setAlarm; ask the supervisor (root) via a props stub.
        const ms = Number(url.searchParams.get("ms") ?? 3000);
        const at = await this.ctx.props.sched.setAlarm(Date.now() + ms);
        return Response.json({ proxiedAlarmAt: at });
      }
      case "/getalarm":
        return Response.json({ getAlarm: await s.getAlarm() });
      case "/ws": {
        if (req.headers.get("upgrade") !== "websocket") return new Response("need ws", { status: 426 });
        const [client, server] = Object.values(new WebSocketPair());
        this.ctx.acceptWebSocket(server, ["tagA"]);
        server.serializeAttachment({ joinedAt: Date.now(), v: VERSION });
        return new Response(null, { status: 101, webSocket: client });
      }
      case "/outbound": {
        try {
          const r = await fetch("https://example.com/");
          return Response.json({ fetched: r.status });
        } catch (e) {
          return Response.json({ blocked: String(e) });
        }
      }
      case "/env":
        return Response.json({ envKeys: Object.keys(this.env ?? {}) });
    }
    return new Response(`app ${VERSION}: unknown ${url.pathname}`, { status: 404 });
  }

  // Called by the supervisor's alarm() (alarm proxy).
  async runAlarm(info) {
    await this.alarm(info);
    return "ok";
  }

  async webSocketMessage(ws, msg) {
    ws.send(
      JSON.stringify({
        echo: String(msg),
        v: VERSION,
        attachment: ws.deserializeAttachment(),
        tags: this.ctx.getTags(ws),
        socketsTagA: this.ctx.getWebSockets("tagA").length,
      }),
    );
  }

  async webSocketClose(ws, code, reason) {
    console.log(`${ts()} [facet ws close] ${code} ${reason}`);
  }

  async alarm(info) {
    this.ctx.storage.sql.exec(
      "INSERT INTO alarm_runs (v, at, retry) VALUES (?, ?, ?)",
      VERSION, Date.now(), info?.retryCount ?? -1,
    );
    console.log(`${ts()} [facet alarm] v=${VERSION} id.name=${this.ctx.id.name} retry=${info?.retryCount}`);
  }
}

// Plain stateless entrypoint, used for loader latency / memory measurements.
export default {
  fetch() {
    return new Response(VERSION);
  },
};

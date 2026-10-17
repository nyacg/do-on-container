// Supervisor worker: AppRunner DO hosts tenant code (loaded via env.LOADER) as a facet with its
// own SQLite. Routes:
//   /t/<runner>/<code-id>/<app path>   → AppRunner(<runner>).fetch → facet "app" running <code-id>
//   /rpc/<runner>/<code-id>             → RPC calls on the facet stub
//   /swap/<runner>/<code-id>            → facets.abort("app") then get() with the new code id
//   /delete/<runner>                    → facets.delete("app")
//   /clone/<runner>/<dst>               → facets.clone("app", dst)
//   /rootDeleteAll/<runner>             → root ctx.storage.deleteAll() (cascades facet files)
//   /root/<runner>                      → root kv/tables/alarm
//   /load?n=&prefix=                    → load n distinct NAMED code ids (stateless), timing
//   /loadanon?n=                        → LOADER.load() n unnamed workers (GC-able)
//   /cpu?limit=50                       → is limits.cpuMs enforced? (no)
// Facet alarms: app calls ctx.props.sched.setAlarm(at) → Sched entrypoint → root setAlarm;
// root alarm() → facet.runAlarm().
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import APP_SRC from "app.js";

const ts = () => new Date().toISOString();
const codeFor = (codeId) => APP_SRC.replace("__VERSION__", codeId);
let loads = 0; // how many times the LOADER callback actually ran (cache misses)

function load(env, codeId, opts = {}) {
  return env.LOADER.get(codeId, async () => {
    loads++;
    return {
      compatibilityDate: "2026-09-01",
      mainModule: "app.js",
      modules: { "app.js": codeFor(codeId) },
      globalOutbound: opts.outbound === "inherit" ? undefined : null,
      env: opts.env ?? {},
    };
  });
}

export class AppRunner extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    console.log(`${ts()} [runner construct] ${ctx.id.name}`);
  }

  facet(codeId) {
    // The callback only runs when the facet isn't already running in this actor.
    return this.ctx.facets.get("app", async () => {
      const id = codeId ?? (await this.ctx.storage.get("codeId")) ?? "v1";
      await this.ctx.storage.put("codeId", id);
      this.ctx.storage.kv.put("facetStarts", (this.ctx.storage.kv.get("facetStarts") ?? 0) + 1);
      console.log(`${ts()} [runner] starting facet app with code ${id}`);
      // Per-runner props: an RPC stub back to this runner, used as the facet's alarm proxy.
      const sched = this.ctx.exports.Sched({ props: { runner: this.ctx.id.name } });
      return { class: load(this.env, id).getDurableObjectClass("App", { props: { sched } }) };
    });
  }

  async fetch(req) {
    const url = new URL(req.url);
    const [, kind, , codeId, ...rest] = url.pathname.split("/");
    if (kind === "t") {
      const inner = new URL(req.url);
      inner.pathname = "/" + rest.join("/");
      return this.facet(codeId).fetch(new Request(inner, req));
    }
    return new Response("?", { status: 404 });
  }

  // ---- RPC from the router ----
  async rpc(codeId) {
    const f = this.facet(codeId);
    return { hello: await f.hello("supervisor"), info: await f.info() };
  }
  async swap(codeId) {
    this.ctx.facets.abort("app", new Error("code swap"));
    await this.ctx.storage.put("codeId", codeId);
    const f = this.facet(codeId);
    return await f.info();
  }
  async del() {
    this.ctx.facets.delete("app");
    return "deleted";
  }
  async rootDeleteAll() {
    await this.ctx.storage.deleteAll();
    return "root deleteAll done";
  }
  async cloneTo(dst) {
    this.ctx.facets.clone("app", dst);
    const id = (await this.ctx.storage.get("codeId")) ?? "v1";
    const f = this.ctx.facets.get(dst, () => ({ class: load(this.env, id).getDurableObjectClass("App") }));
    return await f.info();
  }
  async rootInfo() {
    return {
      rootKv: [...this.ctx.storage.kv.list()],
      loaderCallbacksThisIsolate: loads,
      rootTables: this.ctx.storage.sql.exec("SELECT name FROM sqlite_master").toArray(),
      rootAlarm: await this.ctx.storage.getAlarm(),
    };
  }

  async facetSetAlarm(at) {
    await this.ctx.storage.setAlarm(at);
    return await this.ctx.storage.getAlarm();
  }

  // Root alarm → forward to the facet (facets can't own alarms in workerd).
  async alarm(info) {
    console.log(`${ts()} [runner alarm] ${this.ctx.id.name} retry=${info?.retryCount} -> facet`);
    await this.facet().runAlarm({ retryCount: info?.retryCount ?? 0, isRetry: !!info?.isRetry });
  }
}

export class Sched extends WorkerEntrypoint {
  setAlarm(at) {
    return this.env.RUNNER.getByName(this.ctx.props.runner).facetSetAlarm(at);
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const parts = url.pathname.split("/");
    const runner = () => env.RUNNER.getByName(parts[2]);
    try {
      switch (parts[1]) {
        case "t":
          return runner().fetch(req);
        case "rpc":
          return Response.json(await runner().rpc(parts[3]));
        case "swap":
          return Response.json(await runner().swap(parts[3]));
        case "delete":
          return Response.json(await runner().del());
        case "rootDeleteAll":
          return Response.json(await runner().rootDeleteAll());
        case "clone":
          return Response.json(await runner().cloneTo(parts[3]));
        case "root":
          return Response.json(await runner().rootInfo());
        case "load": {
          // Load n distinct code ids as stateless workers; time cold vs warm.
          const n = Number(url.searchParams.get("n") ?? 1);
          const prefix = url.searchParams.get("prefix") ?? "m";
          const outbound = url.searchParams.get("outbound") ?? "null";
          const before = loads;
          const t0 = performance.now();
          let t = Date.now();
          const cold = [];
          for (let i = 0; i < n; i++) {
            const s = Date.now();
            await (await load(env, `${prefix}${i}`, { outbound }).getEntrypoint().fetch("http://x/")).text();
            cold.push(Date.now() - s);
          }
          const coldTotal = Date.now() - t;
          t = Date.now();
          const warm = [];
          for (let i = 0; i < n; i++) {
            const s = Date.now();
            await (await load(env, `${prefix}${i}`).getEntrypoint().fetch("http://x/")).text();
            warm.push(Date.now() - s);
          }
          const warmTotal = Date.now() - t;
          const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
          return Response.json({
            n, loaderCallbacks: loads - before, coldTotal, warmTotal,
            coldMedian: med(cold), warmMedian: med(warm), coldFirst: cold[0], coldMax: Math.max(...cold),
          });
        }
        case "loadanon": {
          // Unnamed workers (LOADER.load) are owned by their JS handle only, so they can be GC'd.
          const n = Number(url.searchParams.get("n") ?? 1);
          const prefix = url.searchParams.get("prefix") ?? "anon";
          const t = Date.now();
          for (let i = 0; i < n; i++) {
            const w = env.LOADER.load({
              compatibilityDate: "2026-09-01", mainModule: "app.js",
              modules: { "app.js": codeFor(`${prefix}${i}`) }, globalOutbound: null,
            });
            await (await w.getEntrypoint().fetch("http://x/")).text();
          }
          return Response.json({ n, ms: Date.now() - t });
        }
        case "cpu": {
          // Does workerd enforce `limits.cpuMs` on dynamic workers? Busy-loop 2s with a 50ms limit.
          const w = env.LOADER.load({
            compatibilityDate: "2026-09-01", mainModule: "b.js", globalOutbound: null,
            limits: { cpuMs: Number(url.searchParams.get("limit") ?? 50) },
            modules: { "b.js": "export default { fetch() { const e = Date.now() + 2000; let x = 0; while (Date.now() < e) x++; return new Response(String(x)); } }" },
          });
          const t = Date.now();
          try {
            const r = await w.getEntrypoint().fetch("http://x/");
            return Response.json({ status: r.status, body: (await r.text()).slice(0, 80), ms: Date.now() - t });
          } catch (e) {
            return Response.json({ error: String(e), ms: Date.now() - t });
          }
        }
        case "outbound": {
          const mode = url.searchParams.get("mode") ?? "null";
          const w = load(env, `ob-${mode}`, { outbound: mode });
          return Response.json({ mode, status: (await w.getEntrypoint().fetch("http://x/")).status });
        }
      }
    } catch (e) {
      return new Response(String(e?.stack ?? e), { status: 500 });
    }
    return new Response("host ok");
  },
};

// Phase 0 spike: native ctx.container + scheduling_policy "durable_object".
// Measures start latency, placement locality (locationHint), container & directory snapshots,
// and native outbound interception. Isolated worker: do-pool-v2-spike.
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

export class Bridge extends WorkerEntrypoint {
  async fetch(req) {
    return new Response(`bridge ok; props=${JSON.stringify(this.ctx.props)}; url=${req.url}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Node extends DurableObject {
  async waitReady(t0, timeoutMs = 60000) {
    const port = this.ctx.container.getTcpPort(8080);
    let attempts = 0;
    let lastErr = "";
    while (Date.now() - t0 < timeoutMs) {
      attempts++;
      try {
        const r = await port.fetch("http://c/__stats");
        if (r.ok) return { readyMs: Date.now() - t0, attempts, stats: await r.json() };
        lastErr = "status " + r.status;
      } catch (e) { lastErr = String(e).slice(0, 200); }
      await sleep(50);
    }
    throw new Error("container not ready after " + timeoutMs + "ms; last: " + lastErr);
  }

  async doLocation() {
    const t = await (await fetch("https://cloudflare.com/cdn-cgi/trace")).text();
    return Object.fromEntries(t.trim().split("\n").map((l) => l.split("="))).colo;
  }

  async op(op, q) {
    const c = this.ctx.container;
    const t0 = Date.now();
    switch (op) {
      case "start": {
        if (c.running) return { already: true, ...(await this.waitReady(t0)) };
        const opts = { image: c.images.node, instance: q.custom ? JSON.parse(q.custom) : (q.instance ?? "standard-1"), enableInternet: false, env: { NODE_NAME: "spike" } };
        const snap = await this.ctx.storage.get(q.from ?? "none");
        if (q.from === "container" && snap) { delete opts.image; opts.containerSnapshot = { id: snap.id }; }
        if (q.from === "dir" && snap) opts.directorySnapshots = [{ snapshot: snap, mountPoint: "/data" }];
        if (q.image) opts.image = c.images[q.image];
        c.start(opts);
        await c.interceptOutboundHttp("bridge.internal", this.ctx.exports.Bridge({ props: { node: "spike" } }));
        const r = await this.waitReady(t0);
        return { ...r, opts: { ...opts, directorySnapshots: !!opts.directorySnapshots }, doColo: await this.doLocation() };
      }
      case "inspect":
        return { running: c.running, images: c.images, info: await c.inspect?.() };
      case "snapshot": {
        const s = await c.snapshotContainer({ name: q.name ?? "spike" });
        await this.ctx.storage.put("container", s);
        return { ms: Date.now() - t0, snapshot: s };
      }
      case "snapdir": {
        if (!c.snapshotDirectory) return { error: "snapshotDirectory not available" };
        const s = await c.snapshotDirectory({ dir: q.dir ?? "/data", name: q.name ?? "data" });
        await this.ctx.storage.put("dir", s);
        return { ms: Date.now() - t0, snapshot: s };
      }
      case "stop": {
        if (!c.running) return { running: false };
        if (q.kill) await c.destroy("spike kill");
        else c.signal(15);
        const mon = c.monitor().catch((e) => String(e));
        await Promise.race([mon, sleep(30000)]);
        return { ms: Date.now() - t0, running: c.running };
      }
      case "exec": {
        if (!c.exec) return { error: "exec not available" };
        const p = await c.exec(JSON.parse(q.cmd), { stdout: "pipe", stderr: "combined", signal: AbortSignal.timeout(15000) });
        const out = await p.output?.();
        return { ms: Date.now() - t0, out: out && { stdout: new TextDecoder().decode(out.stdout), stderr: new TextDecoder().decode(out.stderr), exitCode: out.exitCode } };
      }
    }
    return { error: "unknown op " + op };
  }

  async fetch(req) {
    const url = new URL(req.url);
    const [, , , op, ...rest] = url.pathname.split("/"); // /n/<name>/<op>/...
    if (op === "p") {
      if (!this.ctx.container.running) return new Response("not running", { status: 503 });
      try {
        return await this.ctx.container.getTcpPort(8080).fetch("http://c/" + rest.join("/") + url.search, req);
      } catch (e) {
        return Response.json({ passthroughError: String(e) }, { status: 502 });
      }
    }
    try {
      return Response.json(await this.op(op, Object.fromEntries(url.searchParams)));
    } catch (e) {
      return Response.json({ error: String(e), stack: e?.stack?.split("\n").slice(0, 4) }, { status: 500 });
    }
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/facet/")) return env.FACET.getByName(url.pathname.slice(7)).fetch(req);
    const m = url.pathname.match(/^\/n\/([^/]+)\//);
    if (!m) return new Response("usage: /n/<name>/<start|snapshot|snapdir|stop|inspect|exec|p/...>?hint=wnam");
    const hint = url.searchParams.get("hint");
    const stub = env.NODE.get(env.NODE.idFromName(m[1]), hint ? { locationHint: hint } : undefined);
    return stub.fetch(req);
  },
};

// Real-DO facet + Worker Loader check (Dynamic Workers on Cloudflare)
const APP_CODE = `import { DurableObject } from "cloudflare:workers";
export class App extends DurableObject {
  async fetch(req) {
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS hits (n INTEGER)");
    this.ctx.storage.sql.exec("INSERT INTO hits VALUES (1)");
    const n = this.ctx.storage.sql.exec("SELECT count(*) AS n FROM hits").one().n;
    let alarm; try { await this.ctx.storage.setAlarm(Date.now() + 60000); alarm = "ok"; } catch (e) { alarm = String(e); }
    return Response.json({ facet: true, n, name: this.ctx.id.name ?? null, alarm });
  }
}`;
export class Ctl extends WorkerEntrypoint {
  ping() { return "pong " + this.ctx.props.name; }
}
const ENV_APP = `import { DurableObject } from "cloudflare:workers";
export class App extends DurableObject { async fetch() { return Response.json({ ping: await this.env.HOST.ping(), name: this.ctx.id.name }); } }`;
const SHIM = `import * as user from "./user.js"; export class App extends user.App {}`;
export class FacetHost extends DurableObject {
  async fetch(req) {
    const q = new URL(req.url).searchParams;
    try {
      const facet = this.ctx.facets.get("app", async () => {
        const id = "app-" + (q.get("shim") ? "shim" : "plain") + (q.get("props") ? "-props" : "");
        const modules = q.get("shim") ? { "shim.js": SHIM, "user.js": APP_CODE } : { "app.js": APP_CODE };
        const envStub = q.get("envstub") ? { HOST: this.ctx.exports.Ctl({ props: { name: "via-env" } }) } : {};
        const w = this.env.LOADER.get(id + (q.get("envstub") ? "-env" : ""), async () => ({ compatibilityDate: "2026-10-15", mainModule: q.get("shim") ? "shim.js" : "app.js", modules: q.get("envstub") ? { "app.js": ENV_APP } : modules, globalOutbound: null, env: envStub }));
        const opts = q.get("props") === "plain" ? { props: { flag: true } } : q.get("props") ? { props: { host: this.ctx.exports.Ctl({ props: { name: "x" } }), flag: true } } : undefined;
        return { class: w.getDurableObjectClass("App", opts) };
      });
      return await facet.fetch(req);
    } catch (e) {
      return Response.json({ error: String(e) }, { status: 500 });
    }
  }
}

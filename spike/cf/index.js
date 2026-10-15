import { Container } from "@cloudflare/containers";
import { DurableObject } from "cloudflare:workers";
export { ContainerProxy } from "@cloudflare/containers";
export { Room } from "../worker.js";

export class Stats extends DurableObject {
  async put(k, v) { this.ctx.storage.kv.put(k, v); }
  async all() { return Object.fromEntries(this.ctx.storage.kv.list()); }
}

export class PoolNode extends Container {
  defaultPort = 8080;
  envVars = { PUSH_STATS: "1" };
  sleepAfter = "10m";
  enableInternet = false;
  // raw runtime passthrough (no per-message JS) — bypasses the library's WS proxy
  async fetch(req) {
    const url = new URL(req.url);
    if (url.searchParams.get("mode") === "raw") {
      if (!this.ctx.container.running) await this.startAndWaitForPorts(8080);
      this.renewActivityTimeout();
      return this.ctx.container.getTcpPort(8080).fetch(req.url.replace("https:", "http:"), req);
    }
    return super.fetch(req);
  }
}

export class PoolLite extends PoolNode {}
export class PoolBasic extends PoolNode {}
export class PoolS2 extends PoolNode {}
export class PoolS4 extends PoolNode {}
// celld (denoland/celld) running the identical Room class, same instance sizes.
export class CelldBasic extends PoolNode {}
export class CelldS2 extends PoolNode {}
const POOLS = { lite: "POOL_LITE", basic: "POOL_BASIC", s1: "POOL", s2: "POOL_S2", s4: "POOL_S4", celld: "CELLD_BASIC", celld2: "CELLD_S2" };

// NB: must be an assignment (hits the inherited static setter); a `static outboundByHost = {}` class field silently shadows it.
for (const C of [PoolNode, PoolLite, PoolBasic, PoolS2, PoolS4, CelldBasic, CelldS2]) C.outboundByHost = {
  "bridge.internal": async (req, env, ctx) => {
    if (new URL(req.url).pathname === "/stats") {
      const body = await req.json();
      await env.STATS.getByName("s").put(ctx.className + ":" + ctx.containerId.slice(0, 8), { ...body, at: Date.now() });
      return new Response("ok");
    }
    return new Response(`pong from worker; containerId=${ctx.containerId}; url=${req.url}`);
  },
};

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    // /do/...   -> real Durable Object (control)
    // /pool/... -> container hosting workerd DOs
    if (url.pathname.startsWith("/do/")) {
      const rest = url.pathname.slice(3);
      const m = rest.match(/^\/r\/([^/]+)/);
      if (!m) return new Response("bad", { status: 400 });
      const inner = new Request(new URL(rest + url.search, url), req);
      return env.ROOM.get(env.ROOM.idFromName(m[1])).fetch(inner);
    }
    if (url.pathname.startsWith("/pool/")) {
      const node = url.searchParams.get("node") ?? "node-0";
      const inner = new Request(new URL(url.pathname.slice(5) + url.search, url), req);
      const h = new Headers(inner.headers); h.delete("sec-websocket-extensions");
      const ns = env[POOLS[url.searchParams.get("type") ?? "s1"]];
      return ns.getByName(node).fetch(new Request(inner, { headers: h }));
    }
    if (url.pathname === "/stats") return Response.json(await env.STATS.getByName("s").all());
    return new Response("do-pool spike");
  },
};

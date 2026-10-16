// Tiny tenant worker: one SQLite-backed DO + an escape probe via a disk service rooted at "/".
import { DurableObject } from "cloudflare:workers";

export class Counter extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS c (k TEXT PRIMARY KEY, v INTEGER)");
  }
  async fetch() {
    this.ctx.storage.sql.exec("INSERT INTO c VALUES ('n', 1) ON CONFLICT(k) DO UPDATE SET v = v + 1");
    const v = this.ctx.storage.sql.exec("SELECT v FROM c WHERE k = 'n'").one().v;
    return Response.json({ tenant: this.env.TENANT, count: v });
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/read") {
      // Try to read an arbitrary path through the "/"-rooted disk service.
      const p = url.searchParams.get("p") ?? "/";
      const r = await env.ROOT.fetch("http://disk" + p);
      return new Response(`status=${r.status}\n${(await r.text()).slice(0, 400)}`);
    }
    const name = url.searchParams.get("name") ?? "a";
    return env.COUNTER.get(env.COUNTER.idFromName(name)).fetch(req);
  },
};

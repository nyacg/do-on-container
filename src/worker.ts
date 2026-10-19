import { CLASSES, isClassSlug, type ClassSlug } from "../objects";
import type { Env } from "./env";
import { CONFORMANCE_APP } from "../objects/generated/conformance-app";

export { CursorRoom, YDoc, Ticker, Conformance, FacetHost, FacetCtl, BindingsDemo, AiRoom, Lobby } from "../objects";
export { ContainerProxy } from "@cloudflare/containers";
// v1 (live deployment) runs the pool in this script; v2 runs it in src/control.ts.
export { PoolNode } from "./pool-node";
export { Placement } from "./placement";

/**
 * Edge router.
 *
 *   /do/<class>/<name>/...    → a real Durable Object (control arm)
 *   /pool/<class>/<name>/...  → the same class running inside a pooled container
 *   /api/...                  → pool status + admin
 *   everything else           → static assets (web/public)
 */

// ---- app registry (facets): apps/<appId> → codeId, code/<codeId>.js in R2 ----
const appCache = new Map<string, { codeId: string | null; exp: number }>();

async function appCode(env: Env, appId: string): Promise<string | null> {
  const hit = appCache.get(appId);
  if (hit && hit.exp > Date.now()) return hit.codeId;
  const codeId = (await (await env.CHECKPOINTS.get(`apps/${appId}`))?.text()) ?? null;
  appCache.set(appId, { codeId, exp: Date.now() + 5_000 });
  return codeId;
}

async function publishApp(env: Env, appId: string, source: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  const codeId = [...new Uint8Array(digest)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
  await env.CHECKPOINTS.put(`code/${codeId}.js`, source);
  await env.CHECKPOINTS.put(`apps/${appId}`, codeId);
  appCache.delete(appId);
  return { appId, codeId, bytes: source.length };
}

/** App objects are named `<appId>:<object>`; the request carries the app's current code id. */
async function withAppCode(req: Request, env: Env, name: string): Promise<Request | Response> {
  const appId = name.split(":")[0];
  const codeId = name.includes(":") ? await appCode(env, appId) : null;
  if (!codeId) return new Response(`unknown app "${appId}" (name app objects <appId>:<name>)`, { status: 404 });
  const headers = new Headers(req.headers);
  headers.set("x-app-code", codeId);
  return new Request(req, { headers });
}

// Placement lookups are cached per isolate; nodes answer 410 for objects they no longer own.
const placementCache = new Map<string, { node: string; epoch: number; exp: number }>();
const CACHE_MS = 30_000;

type Placed = { node: string; fresh: boolean; epoch: number };

const MIDDLE_EAST = new Set(["AE", "SA", "QA", "KW", "BH", "OM", "IL", "JO", "LB", "IQ", "IR", "TR", "EG"]);

/** Durable Object location hint for the caller, used to place *new* objects nearby. */
export function regionOf(req: Request): string | undefined {
  const cf = req.cf as IncomingRequestCfProperties | undefined;
  if (!cf?.continent) return undefined;
  switch (cf.continent) {
    case "NA":
      return Number(cf.longitude) < -100 ? "wnam" : "enam";
    case "SA":
      return "sam";
    case "EU":
      return "weur";
    case "AF":
      return MIDDLE_EAST.has(String(cf.country)) ? "me" : "afr";
    case "AS":
      return MIDDLE_EAST.has(String(cf.country)) ? "me" : "apac";
    case "OC":
      return "oc";
  }
  return undefined;
}

async function resolveNode(env: Env, key: string, refresh = false, region?: string): Promise<Placed> {
  const hit = placementCache.get(key);
  if (!refresh && hit && hit.exp > Date.now()) return { node: hit.node, epoch: hit.epoch, fresh: false };
  const r = await env.PLACEMENT.getByName("global").resolve(key, region);
  placementCache.set(key, { node: r.node, epoch: r.epoch, exp: Date.now() + CACHE_MS });
  return r;
}

function forPool(req: Request, cls: ClassSlug, name: string, { fresh, epoch }: Placed): Request {
  const headers = new Headers(req.headers);
  // Only the bindings bridge may select internal RPC dispatch.
  headers.delete("x-do-call");
  headers.set("x-do-class", cls);
  headers.set("x-do-name", name);
  headers.set("x-do-epoch", String(epoch));
  // Brand-new object: the node can skip looking for a checkpoint to hydrate from.
  if (fresh) headers.set("x-do-fresh", "1");
  else headers.delete("x-do-fresh");
  // Don't negotiate permessage-deflate with workerd: ~300KB of zlib state per socket.
  headers.delete("sec-websocket-extensions");
  return new Request(req, { headers });
}

async function toPool(req: Request, env: Env, cls: ClassSlug, name: string): Promise<Response> {
  const key = `${cls}/${name}`;
  const region = env.POOL_REGIONS === "1" ? (new URL(req.url).searchParams.get("region") ?? regionOf(req)) : undefined;
  let placed = await resolveNode(env, key, false, region);
  const t0 = Date.now();
  let res = await env.POOL.getByName(placed.node).fetch(forPool(req, cls, name, placed));
  if (res.status === 410 && res.headers.has("x-pool-moved") && (req.method === "GET" || req.method === "HEAD")) {
    placed = await resolveNode(env, key, true, region);
    res = await env.POOL.getByName(placed.node).fetch(forPool(req, cls, name, placed));
  }
  const node = placed.node;
  if (res.webSocket) return res;
  const out = new Response(res.body, res);
  out.headers.set("x-pool-node", node);
  out.headers.set("x-pool-ms", String(Date.now() - t0));
  return out;
}

function toRealDO(req: Request, env: Env, cls: ClassSlug, name: string): Promise<Response> {
  const ns = (env as unknown as Record<string, DurableObjectNamespace>)[CLASSES[cls].binding];
  return ns.getByName(name).fetch(req);
}

function isAdmin(req: Request, env: Env & { ADMIN_TOKEN?: string }) {
  if (!env.ADMIN_TOKEN) return false;
  const given = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? new URL(req.url).searchParams.get("token");
  return given === env.ADMIN_TOKEN;
}

async function api(req: Request, env: Env & { ADMIN_TOKEN?: string }, path: string[]): Promise<Response> {
  const placement = env.PLACEMENT.getByName("global");
  const url = new URL(req.url);
  if (path[0] === "status") return Response.json(await placement.status());
  // Published apps (facets / dynamic workers): list, and read a version's source.
  if (path[0] === "apps" && req.method === "GET") {
    if (path[1] && path[2] === "source") {
      const codeId = url.searchParams.get("code") ?? (await appCode(env, path[1]));
      const obj = codeId ? await env.CHECKPOINTS.get(`code/${codeId}.js`) : null;
      return obj ? new Response(obj.body, { headers: { "content-type": "text/javascript; charset=utf-8", "x-code-id": codeId! } }) : new Response("not found", { status: 404 });
    }
    const listed = await env.CHECKPOINTS.list({ prefix: "apps/" });
    const apps = await Promise.all(
      listed.objects.map(async (o) => ({ appId: o.key.slice(5), codeId: await appCode(env, o.key.slice(5)), updated: o.uploaded })),
    );
    return Response.json(apps);
  }
  if (path[0] === "node" && /^node-\d+$/.test(path[1] ?? "") && req.method === "GET") {
    const node = env.POOL.getByName(path[1]);
    return Response.json(path[2] === "info" ? await node.info() : await node.nodeStats());
  }
  if (!isAdmin(req, env)) return new Response("admin token required", { status: 401 });
  switch (path[0]) {
    case "add-node":
      return Response.json({ node: await placement.addNode(url.searchParams.get("region") ?? undefined) });
    case "drain":
      await placement.drainNode(url.searchParams.get("node") ?? "");
      return Response.json({ ok: true });
    case "stop-node":
      // SIGTERM, exactly what a rollout does: the supervisor drains before exiting.
      await env.POOL.getByName(url.searchParams.get("node") ?? "").shutdown();
      return Response.json({ ok: true });
    case "code": {
      const appId = url.searchParams.get("app") ?? "";
      if (!/^[a-z0-9-]{1,40}$/.test(appId)) return new Response("bad app id", { status: 400 });
      const source = url.searchParams.get("builtin") === "conformance" ? CONFORMANCE_APP : await req.text();
      return Response.json(await publishApp(env, appId, source));
    }
    case "code-source": {
      const obj = await env.CHECKPOINTS.get(`code/${url.searchParams.get("code")}.js`);
      return obj ? new Response(obj.body) : new Response("not found", { status: 404 });
    }
    case "rollout":
      return Response.json(await placement.rollout());
    case "probe":
      return new Response(await env.POOL.getByName(url.searchParams.get("node") ?? "").probe(url.searchParams.get("app") ?? ""));
    case "sleep-node":
      return Response.json(await env.POOL.getByName(url.searchParams.get("node") ?? "").sleep("manual"));
    case "kill-node":
      await env.POOL.getByName(url.searchParams.get("node") ?? "").kill();
      return Response.json({ ok: true });
    case "migrate":
      return Response.json({ node: await placement.migrate(url.searchParams.get("key") ?? "") });
    case "config": {
      const c: Record<string, number> = {};
      for (const k of ["minNodes", "maxNodes", "maxConns"]) if (url.searchParams.has(k)) c[k] = Number(url.searchParams.get(k));
      return Response.json(await placement.setConfig(c));
    }
    case "reset":
      await placement.reset();
      placementCache.clear();
      return Response.json({ ok: true });
  }
  return new Response("not found", { status: 404 });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const [backend, ...rest] = url.pathname.slice(1).split("/");
    if (backend === "api") return api(req, env, rest);
    if (backend === "do" || backend === "pool") {
      const [cls, name] = rest;
      if (!cls || !isClassSlug(cls) || !name) return new Response("usage: /{do|pool}/{cursors|doc|ticker|conf|bind|room|lobby|app}/{name}", { status: 400 });
      let r: Request | Response = req;
      if (cls === "app" || cls === "sapp") {
        r = await withAppCode(req, env, name);
        if (r instanceof Response) return r;
      }
      return backend === "do" ? toRealDO(r, env, cls, name) : toPool(r, env, cls, name);
    }
    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;

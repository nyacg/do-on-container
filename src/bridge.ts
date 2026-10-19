import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./env";
import { rpc } from "./rpc-server";

/**
 * Outbound handler for http://bridge.internal — how code inside the container reaches
 * Worker bindings. Runs in the Worker (v1: a ContainerProxy entrypoint; v2: the `Bridge`
 * entrypoint below, bound per node via ctx.exports), not in the PoolNode DO, so it doesn't
 * contend with the node's request path.
 *
 *   PUT/GET /blob/<key>     → R2 (GET honours `range: bytes=a-b`); checkpoint segments + manifests
 *   GET     /list?prefix=   → R2 key listing
 *   POST    /stats          → Placement.report(node, stats)
 *   POST    /drained        → Placement.registerAlarms(drain result's pending alarms)
 *   POST    /rpc            → a pooled object's binding call (env.KV / FILES / AI / ECHO / CONF…),
 *                             replayed on the real binding; see src/rpc-server.ts
 */
export async function bridge(req: Request, env: Env, ctx: { containerId: string }): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname.startsWith("/blob/")) {
    const key = decodeURIComponent(url.pathname.slice("/blob/".length));
    if (req.method === "PUT") {
      await env.CHECKPOINTS.put(key, req.body, { customMetadata: { container: ctx.containerId.slice(0, 12) } });
      return new Response("ok");
    }
    const range = req.headers.get("range")?.match(/^bytes=(\d+)-(\d+)$/);
    const obj = await env.CHECKPOINTS.get(
      key,
      range ? { range: { offset: Number(range[1]), length: Number(range[2]) - Number(range[1]) + 1 } } : undefined,
    );
    return obj ? new Response(obj.body) : new Response("not found", { status: 404 });
  }
  if (url.pathname === "/list") {
    const prefix = url.searchParams.get("prefix") ?? "";
    const keys: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await env.CHECKPOINTS.list({ prefix, cursor });
      keys.push(...page.objects.map((o) => o.key));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return Response.json(keys);
  }
  if (url.pathname === "/rpc" && req.method === "POST") return rpc(req, env);
  if (url.pathname === "/drained" && req.method === "POST") {
    // The supervisor drained on SIGTERM (platform stop): hand pending alarms to Placement.
    // An empty or partial body means the in-container drain failed (workerd already gone):
    // nothing to register here; Placement recovers alarms from the node's last manifest.
    const r = (await req.json().catch(() => ({}))) as { alarms?: { key: string; at: number }[]; error?: string };
    if (!r.alarms) console.warn(`node ${ctx.containerId}: drain report without alarms`, r.error ?? "(unparseable body)");
    await env.PLACEMENT.getByName("global").registerAlarms(r.alarms ?? []);
    return new Response("ok");
  }
  if (url.pathname === "/stats" && req.method === "POST") {
    const stats = (await req.json()) as { node?: string };
    if (!stats.node) return new Response("missing node", { status: 400 });
    await env.PLACEMENT.getByName("global").report(stats.node, stats);
    return new Response("ok");
  }
  return new Response("unknown bridge path", { status: 404 });
}

/** v2: `ctx.container.interceptOutboundHttp("bridge.internal", ctx.exports.Bridge({ props: { node } }))`. */
export class Bridge extends WorkerEntrypoint<Env, { node: string }> {
  override fetch(req: Request): Promise<Response> {
    return bridge(req, this.env, { containerId: this.ctx.props.node });
  }
}

import type { OutboundHandlerContext } from "@cloudflare/containers";
import type { Env } from "./env";

/**
 * Outbound handler for http://bridge.internal — how code inside the container reaches
 * Worker bindings. Runs in the Worker (a ContainerProxy entrypoint), not in the PoolNode DO,
 * so it doesn't contend with the node's request path.
 *
 *   PUT/GET /blob/<key>     → R2 (GET honours `range: bytes=a-b`); checkpoint segments + manifests
 *   GET     /list?prefix=   → R2 key listing
 *   POST    /stats          → Placement.report(node, stats)
 */
export async function bridge(req: Request, env: Env, ctx: OutboundHandlerContext): Promise<Response> {
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
  if (url.pathname === "/stats" && req.method === "POST") {
    const stats = (await req.json()) as { node?: string };
    if (!stats.node) return new Response("missing node", { status: 400 });
    await env.PLACEMENT.getByName("global").report(stats.node, stats);
    return new Response("ok");
  }
  return new Response("unknown bridge path", { status: 404 });
}

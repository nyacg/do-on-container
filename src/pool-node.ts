import { Container, type StopParams } from "@cloudflare/containers";
import type { Env } from "./env";
import { bridge } from "./bridge";
import type { EvictionResult } from "../objects/pool-protocol";

/**
 * One PoolNode DO fronts one container running workerd with many Durable Objects inside.
 *
 * Requests (HTTP and WebSocket) are handed to the container with a *raw* passthrough:
 * `getTcpPort().fetch()` returns the container's socket to the runtime, so no JavaScript runs
 * per WebSocket message. (`Container.fetch()` from @cloudflare/containers instead accepts both
 * ends and re-sends every frame in JS — it caps out around 1k msg/s and gets every
 * container→client frame billed as an inbound DO WebSocket message.)
 */
export interface DrainResult {
  keys: number;
  objects: number;
  seg: string | null;
  failed: number;
  errors: string[];
  ms: number;
}

export class PoolNode extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "10m";
  enableInternet = false;

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    // Read by every start path in the base class (including containerFetch's auto-start).
    this.envVars = { NODE_NAME: this.nodeName(), CKPT_INTERVAL: env.POOL_CKPT_INTERVAL ?? "30" };
  }

  override async fetch(req: Request): Promise<Response> {
    await this.ensureStarted();
    this.renewActivityTimeout();
    return this.ctx.container!.getTcpPort(8080).fetch(req.url.replace("https:", "http:"), req);
  }

  /** Start the container ahead of traffic (called by Placement when scaling up). */
  async warm(): Promise<void> {
    await this.ensureStarted();
  }

  async isRunning(): Promise<boolean> {
    return !!this.ctx.container?.running;
  }

  async nodeStats(): Promise<Record<string, unknown>> {
    if (!this.ctx.container?.running) return { node: this.nodeName(), running: false };
    const res = await this.admin("/__stats");
    return res.json();
  }

  /** Checkpoint every object and close their sockets; clients reconnect via Placement. */
  async drain(): Promise<DrainResult> {
    if (!this.ctx.container?.running) return { keys: 0, objects: 0, seg: null, failed: 0, errors: [], ms: 0 };
    const res = await this.admin("/__drain", "POST");
    return res.json();
  }

  /** Snapshot these objects into one segment, close their sockets, answer 410 from now on. */
  async evict(items: { key: string; epoch: number }[]): Promise<EvictionResult> {
    if (!this.ctx.container?.running || !items.length) return { evicted: items.length, evictedKeys: items.map((i) => i.key) };
    const res = await this.containerFetch("http://node/__evict", { method: "POST", body: JSON.stringify(items) });
    return res.json();
  }

  /** SIGTERM → the supervisor drains (checkpoint + close sockets) before exiting. */
  async shutdown(): Promise<void> {
    if (this.ctx.container?.running) await this.stop();
  }

  /** SIGKILL: simulates a host failure (no drain, unflushed writes are lost). */
  async kill(): Promise<void> {
    if (this.ctx.container?.running) await this.destroy();
  }

  override async onActivityExpired(): Promise<void> {
    // Raw-passthrough WebSockets don't renew the activity timer, so ask the node whether
    // it still has clients before letting the container sleep.
    try {
      const stats = (await this.nodeStats()) as { conns?: number };
      if ((stats.conns ?? 0) > 0) {
        this.renewActivityTimeout();
        return;
      }
    } catch {}
    await this.stop();
  }

  override async onStop(params: StopParams): Promise<void> {
    if (this.ctx.container?.running) return; // spurious stop while (re)starting
    await this.env.PLACEMENT.getByName("global").nodeStopped(this.nodeName(), params.reason);
  }

  private nodeName() {
    return this.ctx.id.name ?? this.ctx.id.toString();
  }

  private async ensureStarted() {
    if (this.ctx.container?.running && (await this.getState()).status === "healthy") return;
    await this.startAndWaitForPorts(8080);
  }

  private admin(path: string, method = "GET") {
    return this.containerFetch(`http://node${path}`, { method });
  }
}

// Must be an *assignment*: a `static outboundByHost = {}` class field shadows the base class's
// static setter, the handler never registers, and every bridge call 520s.
PoolNode.outboundByHost = { "bridge.internal": bridge };

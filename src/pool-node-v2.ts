import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import type { DrainResult } from "./pool-node";

/**
 * v2 pool node on the native `ctx.container` API with `scheduling_policy: "durable_object"`:
 *
 *  - image and instance size are chosen at start (`ctx.container.images.node`), so a node keeps
 *    its image until *we* replace it — rollouts are Placement's job (blue/green via migration)
 *  - created with a `locationHint` by Placement; the container is scheduled next to this DO
 *  - outbound `http://bridge.internal` is intercepted to the `Bridge` entrypoint (ctx.exports)
 *  - sleeps when idle: drain → filesystem snapshot → stop; wakes from the snapshot (Phase 4)
 *
 * Requests are handed to the container with a raw passthrough (`getTcpPort().fetch()`), so no
 * JavaScript runs per WebSocket message here.
 */
interface SnapshotRecord {
  id: string;
  image: string;
  at: number;
  size: number;
}

const HEARTBEAT_MS = 60_000;
const DEFAULT_SLEEP_AFTER_MS = 10 * 60_000;
const READY_TIMEOUT_MS = 90_000;
const DEFAULT_INSTANCE: ContainerStartupOptions["instance"] = { vcpu: 1, memoryMib: 2048, diskMb: 4000 };

export class PoolNodeV2 extends DurableObject<Env> {
  private starting?: Promise<void>;
  private ready = false;
  private stopping = false;
  private lastRequest = Date.now();
  private sleeping?: Promise<unknown>;
  private lastStart?: { at: number; fromSnapshot: boolean; readyMs?: number };

  override async fetch(req: Request): Promise<Response> {
    if (this.sleeping) await this.sleeping.catch(() => {}); // then wake below
    await this.ensureStarted();
    this.lastRequest = Date.now();
    return this.ctx.container!.getTcpPort(8080).fetch(req.url.replace("https:", "http:"), req);
  }

  // ------------------------------------------------------------------ RPC (from Placement / Worker)

  async warm(): Promise<void> {
    await this.ensureStarted();
  }

  async isRunning(): Promise<boolean> {
    return !!this.ctx.container?.running;
  }

  /** The image the *currently deployed* version would start (asked of a fresh DO by Placement). */
  async latestImage(): Promise<string> {
    return this.ctx.container!.images.node;
  }

  async info() {
    const c = this.ctx.container!;
    return {
      node: this.nodeName(),
      running: c.running,
      image: this.ctx.storage.kv.get<string>("image") ?? null,
      latestImage: c.images.node,
      snapshot: this.ctx.storage.kv.get<SnapshotRecord>("snapshot") ?? null,
      lastStart: this.lastStart ?? null,
    };
  }

  async nodeStats(): Promise<Record<string, unknown>> {
    if (!this.ctx.container?.running) return { node: this.nodeName(), running: false };
    return (await this.admin("/__stats")).json();
  }

  async drain(): Promise<DrainResult & { alarms?: { key: string; at: number }[] }> {
    if (!this.ctx.container?.running) return { keys: 0, objects: 0, seg: null, failed: 0, errors: [], ms: 0 };
    return (await this.admin("/__drain", { method: "POST" })).json();
  }

  async evict(
    items: { key: string; epoch: number }[],
  ): Promise<{ evicted: number; seg?: string | null; alarms?: { key: string; at: number }[] }> {
    if (!this.ctx.container?.running || !items.length) return { evicted: items.length };
    return (await this.admin("/__evict", { method: "POST", body: JSON.stringify(items) })).json();
  }

  /** Alarm registry: construct these objects here so their (re-armed) alarms fire. */
  async wake(items: { key: string; epoch: number }[]): Promise<{ woke: string[]; errors: string[] }> {
    await this.ensureStarted();
    return (await this.admin("/__wake", { method: "POST", body: JSON.stringify(items) })).json();
  }

  /** Isolation self-test: a shell probe run inside an app's sandbox on this node. */
  async probe(app: string): Promise<string> {
    await this.ensureStarted();
    return (await this.admin(`/__probe?app=${encodeURIComponent(app)}`)).text();
  }

  /** SIGTERM: the supervisor drains (checkpoint + close sockets) before exiting. */
  async shutdown(): Promise<void> {
    const c = this.ctx.container!;
    if (!c.running) return;
    this.stopping = true;
    c.signal(15);
    await Promise.race([c.monitor().catch(() => {}), sleep(60_000)]);
    if (c.running) await c.destroy("shutdown timeout");
    // The supervisor drained on SIGTERM; Placement picks pending alarms up from the manifest.
    await this.env.PLACEMENT.getByName("global").nodeStopped(this.nodeName(), "shutdown");
  }

  /** SIGKILL: simulates a host failure (no drain; writes since the last flush are lost). */
  async kill(): Promise<void> {
    if (this.ctx.container?.running) await this.ctx.container.destroy("killed");
  }

  // ------------------------------------------------------------------ lifecycle

  /**
   * Scale to zero: persist, take a filesystem snapshot, stop. The node keeps its objects
   * (Placement marks it `sleeping`); the next request — or a due alarm, via Placement's alarm
   * registry — restarts it from the snapshot with every object's SQLite already on disk.
   */
  async sleep(reason = "idle"): Promise<Record<string, unknown>> {
    this.sleeping ??= this.doSleep(reason).finally(() => (this.sleeping = undefined));
    return (await this.sleeping) as Record<string, unknown>;
  }

  private async doSleep(reason: string) {
    const c = this.ctx.container!;
    if (!c.running) return { slept: false, why: "not running" };
    const t0 = Date.now();
    const open = (await (await this.admin("/__sockets")).json()) as { sockets: number };
    if (open.sockets > 0) return { slept: false, why: `${open.sockets} open sockets` };
    // 1. Persist dirty objects (R2 stays the source of truth) and collect pending alarms.
    const flush = (await (await this.admin("/__flush", { method: "POST" })).json()) as { failed: number };
    if (flush.failed) return { slept: false, why: "flush failed" };
    const pending = (await (await this.admin("/__alarms")).json()) as { key: string; at: number }[];
    // 2. Snapshot the filesystem (all SQLite files), unless something changed meanwhile.
    const snap = await c.snapshotContainer({ name: `${this.nodeName()}-${Date.now()}` });
    const after = (await (await this.admin("/__stats")).json()) as { dirtyObjects: number };
    const { sockets } = (await (await this.admin("/__sockets")).json()) as { sockets: number };
    if (after.dirtyObjects > 0 || sockets > 0) return { slept: false, why: `became busy (dirty ${after.dirtyObjects}, sockets ${sockets})` };
    const image = this.ctx.storage.kv.get<string>("image") ?? c.images.node;
    this.ctx.storage.kv.put("snapshot", { id: snap.id, size: snap.size, image, at: Date.now() } satisfies SnapshotRecord);
    // 3. Tell Placement before stopping, so nothing treats the node as dead.
    await this.env.PLACEMENT.getByName("global").nodeSleeping(this.nodeName(), pending);
    this.stopping = true;
    this.ready = false;
    await c.destroy("sleep");
    await this.ctx.storage.deleteAlarm();
    return { slept: true, reason, ms: Date.now() - t0, snapshotBytes: snap.size, alarms: pending.length };
  }

  /** Heartbeat: keeps this DO (and so its container) alive while in service; sleeps when idle. */
  override async alarm(): Promise<void> {
    const c = this.ctx.container;
    if (!c?.running) return;
    await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_MS);
    const sleepAfter = Number(this.env.POOL_SLEEP_AFTER_MS ?? DEFAULT_SLEEP_AFTER_MS);
    if (!(sleepAfter > 0) || Date.now() - this.lastRequest < sleepAfter) return;
    try {
      const { sockets } = (await (await this.admin("/__sockets")).json()) as { sockets: number };
      if (sockets === 0) await this.sleep("idle");
    } catch {}
  }

  private async ensureStarted() {
    if (this.ctx.container!.running && this.ready) return;
    this.starting ??= this.start().finally(() => (this.starting = undefined));
    await this.starting;
  }

  private async start() {
    const c = this.ctx.container!;
    const t0 = Date.now();
    if (!c.running) {
      const image = c.images.node;
      const snap = this.ctx.storage.kv.get<SnapshotRecord>("snapshot");
      const base = {
        enableInternet: false,
        instance: this.instance(),
        env: { NODE_NAME: this.nodeName(), CKPT_INTERVAL: this.env.POOL_CKPT_INTERVAL ?? "30" },
      };
      // A filesystem snapshot only restores onto the image it was taken from.
      if (snap && snap.image === image) c.start({ ...base, containerSnapshot: { id: snap.id } });
      else c.start({ ...base, image });
      this.lastStart = { at: t0, fromSnapshot: !!(snap && snap.image === image) };
      this.ctx.storage.kv.put("image", image);
      this.ctx.storage.kv.delete("snapshot"); // the running node's disk is now newer
      this.stopping = false;
      this.ctx.waitUntil(this.watch());
    }
    await c.interceptOutboundHttp("bridge.internal", (this.ctx.exports as any).Bridge({ props: { node: this.nodeName() } }));
    await this.waitReady(t0);
    this.ready = true;
    if (this.lastStart?.at === t0) this.lastStart.readyMs = Date.now() - t0;
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_MS);
  }

  private async watch() {
    const c = this.ctx.container!;
    let reason = "exit";
    try {
      await c.monitor();
    } catch (e) {
      reason = `error: ${String(e).slice(0, 120)}`;
    }
    this.ready = false;
    if (!this.stopping) {
      await this.env.PLACEMENT.getByName("global").nodeStopped(this.nodeName(), reason).catch(() => {});
    }
  }

  private async waitReady(t0: number) {
    const port = this.ctx.container!.getTcpPort(8080);
    let last = "";
    while (Date.now() - t0 < READY_TIMEOUT_MS) {
      try {
        const r = await port.fetch("http://node/__stats");
        if (r.ok) return;
        last = `status ${r.status}`;
      } catch (e) {
        last = String(e).slice(0, 120);
      }
      await sleep(100);
    }
    throw new Error(`container not ready after ${READY_TIMEOUT_MS}ms: ${last}`);
  }

  private instance(): ContainerStartupOptions["instance"] {
    const v = this.env.POOL_INSTANCE;
    if (!v) return DEFAULT_INSTANCE;
    return (v.startsWith("{") ? JSON.parse(v) : v) as ContainerStartupOptions["instance"];
  }

  private nodeName() {
    return this.ctx.id.name ?? this.ctx.id.toString();
  }

  private admin(path: string, init?: RequestInit) {
    return this.ctx.container!.getTcpPort(8080).fetch(`http://node${path}`, init);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

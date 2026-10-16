import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";

/**
 * The pool's "load balancer DO". Single instance ("global").
 *
 *  - resolve(key): sticky assignment of a Durable Object (class/name) to a pool node,
 *    picking the least-loaded healthy node and scaling up when every node is hot.
 *  - report(node, stats): nodes push CPU / memory / connection stats every few seconds.
 *  - alarm(): marks silent nodes dead, pre-warms a node when the pool is hot, and drains the
 *    emptiest node when the pool has been cold for a while.
 *
 * Draining a node deletes its assignments and tells it to checkpoint + close every socket.
 * Clients reconnect, the edge Worker re-resolves, and the object hydrates from R2 on its
 * new node.
 *
 * v2 additions:
 *  - regions: nodes are created with a `locationHint`; new objects prefer a node in the
 *    caller's region (the container is scheduled next to its PoolNode DO)
 *  - alarm registry: objects that leave a node (drain, evict, sleep, death) with a pending
 *    alarm are recorded here; Placement's own alarm wakes them on a live node when due
 */

/** suspect = stopped reporting but its container is still running (usually CPU-starved):
 *  keeps its objects, gets no new ones. Only a confirmed-dead node loses its assignments. */
/** retiring = running an outdated image: keeps serving, gets no new objects, and is emptied in
 *  batches by live migration (rollout), then stopped. */
type NodeStatus = "starting" | "active" | "suspect" | "draining" | "retiring" | "sleeping" | "stopped";

interface NodeStats {
  conns?: number;
  cpuCores?: number;
  memUsedKb?: number;
  memTotalKb?: number;
  liveObjects?: number;
  dirtyObjects?: number;
  draining?: boolean;
  [k: string]: unknown;
}

type NodeRow = {
  name: string;
  status: NodeStatus;
  region: string | null;
  created_at: number;
  last_seen: number;
  stats: string | null;
  assigned: number;
};

const ALARM_MS = 10_000;
const STALE_MS = 45_000;
const START_GRACE_MS = 120_000;
// Scale before a node saturates: a CPU-starved container can't even upload its checkpoints
// (bridge requests time out), so it can neither persist nor shed objects.
const SCALE_UP_AT = 0.6;
const SCALE_DOWN_BELOW = 0.25;
const SCALE_DOWN_AFTER_MS = 5 * 60_000;
const DRAIN_TIMEOUT_MS = 3 * 60_000;
const REBALANCE_HOT = 0.8;
const REBALANCE_GAP = 0.3;
const REBALANCE_BATCH = 50;
const ROLLOUT_BATCH = 100;
const ROLLOUT_BATCHES_PER_TICK = 5;
/** New assignments are invisible to node stats for a few seconds; count them meanwhile. */
const RECENT_ASSIGN_MS = 30_000;
const COST_PER_RECENT_ASSIGN = 0.0005;
/** Smoothing for reported CPU so a node's boot/JIT spike doesn't trigger a scale-up. */
const CPU_EWMA_ALPHA = 0.3;

export class Placement extends DurableObject<Env> {
  private sql = this.ctx.storage.sql;
  private recent = new Map<string, number[]>();
  private cpuEwma = new Map<string, number>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        name TEXT PRIMARY KEY, status TEXT NOT NULL, created_at INTEGER NOT NULL,
        last_seen INTEGER NOT NULL, stats TEXT, low_since INTEGER
      );
      CREATE TABLE IF NOT EXISTS assignments (key TEXT PRIMARY KEY, node TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS assignments_node ON assignments(node);
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, kind TEXT, node TEXT, detail TEXT);
      CREATE TABLE IF NOT EXISTS seq (k TEXT PRIMARY KEY, v INTEGER);
      CREATE TABLE IF NOT EXISTS known (key TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS alarms (key TEXT PRIMARY KEY, at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS alarms_at ON alarms(at);
    `);
    try {
      this.sql.exec("ALTER TABLE nodes ADD COLUMN region TEXT");
    } catch {}
  }

  // ------------------------------------------------------------------ public RPC

  /**
   * `fresh` = this object has never been placed before, so there's nothing to hydrate.
   * `epoch` = when this assignment was made; nodes use it to tell a stale request (for an
   * object they've handed off) from a new assignment back to them.
   */
  async resolve(key: string, region?: string): Promise<{ node: string; fresh: boolean; epoch: number }> {
    const row = this.sql
      .exec<{ node: string; status: NodeStatus; at: number }>(
        "SELECT a.node, a.at, n.status FROM assignments a JOIN nodes n ON n.name = a.node WHERE a.key = ?",
        key,
      )
      .toArray()[0];
    // A draining node keeps its objects (answering 410) until they're persisted and released.
    if (row && row.status !== "stopped") return { node: row.node, fresh: false, epoch: row.at };
    const fresh = this.sql.exec("INSERT OR IGNORE INTO known (key) VALUES (?)", key).rowsWritten > 0;
    const node = this.pickNode(undefined, region);
    const epoch = this.assign(key, node);
    const r = this.recent.get(node) ?? [];
    r.push(Date.now());
    this.recent.set(node, r);
    await this.ensureAlarm();
    return { node, fresh, epoch };
  }

  /** (Re)assign `key`; epochs per key strictly increase. */
  private assign(key: string, node: string): number {
    const prev = this.sql.exec<{ at: number }>("SELECT at FROM assignments WHERE key = ?", key).toArray()[0]?.at ?? 0;
    const epoch = Math.max(Date.now(), prev + 1);
    this.sql.exec("INSERT OR REPLACE INTO assignments (key, node, at) VALUES (?, ?, ?)", key, node, epoch);
    return epoch;
  }

  private assignmentsOf(keys: string[]) {
    return keys.map((key) => ({
      key,
      epoch: this.sql.exec<{ at: number }>("SELECT at FROM assignments WHERE key = ?", key).toArray()[0]?.at ?? 0,
    }));
  }

  async report(node: string, stats: NodeStats): Promise<void> {
    const now = Date.now();
    const prev = this.cpuEwma.get(node);
    const cpu = stats.cpuCores ?? 0;
    this.cpuEwma.set(node, prev === undefined ? Math.min(cpu, 0.3) : prev + CPU_EWMA_ALPHA * (cpu - prev));
    const existing = this.getNode(node);
    if (!existing || existing.status === "stopped") {
      // Not a node we're running (stray, or retired but still up): tell it to go away.
      this.ctx.waitUntil(this.env.POOL.getByName(node).shutdown().catch(() => {}));
      return;
    } else {
      const status = existing.status === "draining" || existing.status === "retiring" ? existing.status : "active";
      if (existing.status !== status) this.event("active", node);
      this.sql.exec(
        "UPDATE nodes SET status = ?, last_seen = ?, stats = ? WHERE name = ?",
        status,
        now,
        JSON.stringify(stats),
        node,
      );
    }
    await this.ensureAlarm();
  }

  async nodeStopped(node: string, reason: string): Promise<void> {
    const n = this.getNode(node);
    if (!n || n.status === "sleeping") return;
    if (n.status === "stopped") return void (await this.recoverAlarms(node));
    // Ignore stop events while a node is still booting; the stale check catches real failures.
    if (n.status === "starting" && Date.now() - n.created_at < START_GRACE_MS) return;
    this.event("stopped", node, reason);
    // Assignments are kept: resolve() re-places objects of a stopped node on demand, and they
    // hydrate from R2. Alarms of objects nobody asks for are recovered from the node's manifest.
    this.sql.exec("UPDATE nodes SET status = 'stopped' WHERE name = ?", node);
    await this.recoverAlarms(node);
  }

  /** A node snapshotted itself and is stopping: keep its objects, wake it on demand. */
  async nodeSleeping(node: string, alarms: { key: string; at: number }[]): Promise<void> {
    this.sql.exec("UPDATE nodes SET status = 'sleeping' WHERE name = ?", node);
    this.event("sleep", node, `${alarms.length} pending alarms registered`);
    await this.registerAlarms(alarms);
  }

  // ------------------------------------------------------------------ alarm registry

  /** Objects with pending alarms that are leaving a node: wake them elsewhere when due. */
  async registerAlarms(alarms: { key: string; at: number }[]): Promise<void> {
    for (const a of alarms) this.sql.exec("INSERT OR REPLACE INTO alarms (key, at) VALUES (?, ?)", a.key, a.at);
    if (alarms.length) await this.scheduleAlarm();
  }

  /** A node died without draining: its last checkpoint manifest says which objects had alarms. */
  private async recoverAlarms(node: string) {
    const obj = await this.env.CHECKPOINTS.get(`manifest/${node}`);
    if (!obj) return;
    const m = (await obj.json()) as { entries: Record<string, [string, number, number, number, (number | null)?]> };
    const alarms = Object.entries(m.entries)
      .filter(([key, e]) => e[4] && this.assignedTo(key) === node)
      .map(([key, e]) => ({ key, at: e[4] as number }));
    if (alarms.length) this.event("alarms-recovered", node, `${alarms.length} from manifest`);
    await this.registerAlarms(alarms);
  }

  private assignedTo(key: string): string | undefined {
    return this.sql.exec<{ node: string }>("SELECT node FROM assignments WHERE key = ?", key).toArray()[0]?.node;
  }

  /** Wake objects whose registered alarm is due, on whatever node now owns them. */
  private async fireDueAlarms(now: number) {
    const due = this.sql.exec<{ key: string; at: number }>("SELECT key, at FROM alarms WHERE at <= ? LIMIT 500", now + 1000).toArray();
    if (!due.length) return;
    const byNode = new Map<string, { key: string; epoch: number }[]>();
    for (const { key } of due) {
      const { node, epoch } = await this.resolve(key);
      byNode.set(node, [...(byNode.get(node) ?? []), { key, epoch }]);
    }
    for (const [node, items] of byNode) {
      try {
        const r = await this.env.POOL.getByName(node).wake(items);
        for (const key of r.woke) this.sql.exec("DELETE FROM alarms WHERE key = ?", key);
        this.event("alarms-woken", node, `${r.woke.length}/${items.length}${r.errors.length ? ` errors: ${r.errors[0]}` : ""}`);
      } catch (e) {
        this.event("wake-error", node, String(e).slice(0, 200));
      }
    }
  }

  private async scheduleAlarm() {
    const next = this.sql.exec<{ at: number | null }>("SELECT min(at) AS at FROM alarms").one().at;
    const current = await this.ctx.storage.getAlarm();
    const want = Math.min(next ?? Infinity, current ?? Infinity, Date.now() + ALARM_MS);
    if (current === null || want < current) await this.ctx.storage.setAlarm(Math.max(want, Date.now()));
  }

  /** Move one object to another node (e.g. to rebalance a hot node). */
  async migrate(key: string): Promise<string> {
    const from = this.sql.exec<{ node: string }>("SELECT node FROM assignments WHERE key = ?", key).toArray()[0]?.node;
    const to = this.pickNode(from);
    // Same order as rebalance(): the old node fences, closes and persists the object before
    // the assignment moves. Until then resolve() keeps returning `from`, which answers 410.
    if (from) {
      const r = await this.env.POOL.getByName(from).evict(this.assignmentsOf([key]));
      if (!r.evicted) throw new Error(`evict ${key} from ${from} failed: ${JSON.stringify(r)}`);
      await this.registerAlarms(r.alarms ?? []);
    }
    this.assign(key, to);
    this.event("migrate", to, `${key} from ${from}`);
    return to;
  }

  private async rebalance(from: string, to: string) {
    const keys = this.sql
      .exec<{ key: string }>("SELECT key FROM assignments WHERE node = ? ORDER BY at DESC LIMIT ?", from, REBALANCE_BATCH)
      .toArray()
      .map((r) => r.key);
    if (!keys.length) return;
    // Evict first (fence → close sockets → snapshot persisted), *then* point the keys at `to`,
    // so the new node can never hydrate a snapshot older than the last write.
    const t0 = Date.now();
    const r = await this.env.POOL.getByName(from).evict(this.assignmentsOf(keys));
    if (!r.evicted) {
      this.event("evict-error", from, JSON.stringify(r).slice(0, 200));
      return;
    }
    const now = Date.now();
    for (const key of keys) this.assign(key, to);
    await this.registerAlarms(r.alarms ?? []);
    const recent = this.recent.get(to) ?? [];
    for (const _ of keys) recent.push(now);
    this.recent.set(to, recent);
    this.event("rebalance", from, `${keys.length} objects → ${to} in ${now - t0}ms`);
  }

  async drainNode(node: string): Promise<void> {
    // No new placements here; existing assignments are released only after the node has
    // persisted its objects (see rebalance() for why the order matters).
    this.sql.exec("UPDATE nodes SET status = 'draining', low_since = ? WHERE name = ?", Date.now(), node);
    this.event("drain", node);
    this.ctx.waitUntil(
      this.env.POOL.getByName(node)
        .drain()
        .then(async (r) => {
          await this.registerAlarms(r.alarms ?? []);
          const released = this.sql.exec("DELETE FROM assignments WHERE node = ?", node).rowsWritten;
          this.event("drained", node, `${released} released; ${JSON.stringify(r).slice(0, 200)}`);
        })
        .catch((e) => this.event("drain-error", node, String(e))),
    );
  }

  // ------------------------------------------------------------------ rollouts

  /**
   * Code-driven rollout (scheduling_policy "durable_object" never replaces running containers):
   * nodes whose running image differs from the deployed one become `retiring`; the alarm loop
   * live-migrates their objects to up-to-date nodes in batches (zero-loss move path), then
   * stops them. Rollback = deploy the old image and roll out again.
   */
  async rollout(): Promise<{ node: string; image: string | null; latest: string; retiring: boolean }[]> {
    // Existing DOs pick up a new deploy lazily (minutes), so ask a brand-new, storage-less DO
    // which image the current version would start.
    const latest = await this.env.POOL.getByName(`image-probe-${crypto.randomUUID()}`).latestImage();
    const out = [];
    for (const n of this.nodes().filter((n) => n.status === "active" || n.status === "suspect")) {
      const info = await this.env.POOL.getByName(n.name).info();
      const outdated = !!info.image && info.image !== latest;
      if (outdated) {
        this.sql.exec("UPDATE nodes SET status = 'retiring' WHERE name = ?", n.name);
        this.event("retiring", n.name, `image ${short(info.image)} → ${short(latest)}`);
      }
      out.push({ node: n.name, image: info.image, latest, retiring: outdated });
    }
    await this.ensureAlarm();
    return out;
  }

  private async progressRollout() {
    for (const n of this.nodes().filter((n) => n.status === "retiring")) {
      for (let b = 0; b < ROLLOUT_BATCHES_PER_TICK; b++) {
        const keys = this.sql
          .exec<{ key: string }>("SELECT key FROM assignments WHERE node = ? LIMIT ?", n.name, ROLLOUT_BATCH)
          .toArray()
          .map((r) => r.key);
        if (!keys.length) {
          this.event("retired", n.name, "empty; stopping");
          this.sql.exec("UPDATE nodes SET status = 'stopped' WHERE name = ?", n.name);
          this.ctx.waitUntil(this.env.POOL.getByName(n.name).shutdown().catch(() => {}));
          break;
        }
        const to = this.pickNode(n.name, n.region ?? undefined);
        if (this.getNode(to)?.status !== "active") break; // replacement still starting: next tick
        const r = await this.env.POOL.getByName(n.name).evict(this.assignmentsOf(keys));
        if (!r.evicted) {
          this.event("evict-error", n.name, JSON.stringify(r).slice(0, 200));
          break;
        }
        for (const key of keys) this.assign(key, to);
        await this.registerAlarms(r.alarms ?? []);
        this.event("rollout-move", n.name, `${keys.length} objects → ${to}`);
      }
    }
  }

  async addNode(region?: string): Promise<string> {
    return this.createNode("manual", region);
  }

  async status() {
    const location = (s: string | null) => (s ? (JSON.parse(s) as { cf?: Record<string, string> }).cf?.CLOUDFLARE_LOCATION : undefined);
    const nodes = this.nodes().map((n) => ({
      name: n.name,
      status: n.status,
      assigned: n.assigned,
      load: Number(this.load(n).toFixed(3)),
      cpuEwma: Number((this.cpuEwma.get(n.name) ?? 0).toFixed(3)),
      lastSeenS: Math.round((Date.now() - n.last_seen) / 1000),
      region: n.region,
      location: location(n.stats),
      stats: n.stats ? JSON.parse(n.stats) : null,
    }));
    const events = this.sql
      .exec("SELECT at, kind, node, detail FROM events ORDER BY id DESC LIMIT 30")
      .toArray();
    const assignments = this.sql.exec<{ n: number }>("SELECT count(*) AS n FROM assignments").one().n;
    const alarms = this.sql.exec<{ n: number; next: number | null }>("SELECT count(*) AS n, min(at) AS next FROM alarms").one();
    return { nodes, assignments, alarms, events, config: this.config(), placementVersion: this.env.VERSION?.id };
  }

  async reset(): Promise<void> {
    for (const n of this.nodes()) if (n.status !== "stopped") await this.env.POOL.getByName(n.name).shutdown().catch(() => {});
    this.sql.exec("DELETE FROM nodes; DELETE FROM assignments; DELETE FROM events; DELETE FROM known; DELETE FROM alarms;");
  }

  // ------------------------------------------------------------------ scaling loop

  async alarm(): Promise<void> {
    const now = Date.now();
    const cfg = this.config();
    await this.fireDueAlarms(now);
    for (const [node, ts] of this.recent) {
      const keep = ts.filter((t) => now - t < RECENT_ASSIGN_MS);
      if (keep.length) this.recent.set(node, keep);
      else this.recent.delete(node);
    }

    let nodes = this.nodes();
    // 1. Silent nodes: dead if their container is gone, otherwise suspect (no new objects).
    for (const n of nodes) {
      const grace = n.status === "starting" ? START_GRACE_MS : STALE_MS;
      if ((n.status === "active" || n.status === "starting" || n.status === "suspect") && now - n.last_seen > grace) {
        const running = await this.env.POOL.getByName(n.name)
          .isRunning()
          .catch(() => true);
        const status = running ? "suspect" : "stopped";
        if (status !== n.status) {
          this.sql.exec("UPDATE nodes SET status = ? WHERE name = ?", status, n.name);
          this.event(status === "stopped" ? "dead" : "suspect", n.name, `no stats for ${Math.round((now - n.last_seen) / 1000)}s`);
          if (status === "stopped") await this.recoverAlarms(n.name);
        }
      }
    }
    // 2a. Rollouts: empty retiring nodes onto up-to-date ones.
    await this.progressRollout();
    // 2b. Finish drains: once a draining node has no connections (or times out), stop it.
    for (const n of nodes.filter((n) => n.status === "draining")) {
      const conns = (JSON.parse(n.stats ?? "{}") as NodeStats).conns ?? 0;
      if (conns === 0 || now - (this.lowSince(n.name) ?? now) > DRAIN_TIMEOUT_MS) {
        this.sql.exec("UPDATE nodes SET status = 'stopped' WHERE name = ?", n.name);
        this.event("retire", n.name, `conns=${conns}`);
        this.ctx.waitUntil(this.env.POOL.getByName(n.name).shutdown().catch(() => {}));
      }
    }

    nodes = this.nodes().filter((n) => n.status === "active" || n.status === "starting");
    // 3. Keep the floor (a sleeping node counts: it wakes on the next request), in the region
    //    where most objects live, so it's useful to them.
    const sleeping = this.nodes().filter((n) => n.status === "sleeping").length;
    const busiest = this.sql
      .exec<{ region: string | null }>(
        "SELECT n.region FROM assignments a JOIN nodes n ON n.name = a.node WHERE n.region IS NOT NULL GROUP BY n.region ORDER BY count(*) DESC LIMIT 1",
      )
      .toArray()[0]?.region ?? undefined;
    for (let i = nodes.length + sleeping; i < cfg.minNodes; i++) this.createNode("min-nodes", busiest);

    // 4. Pre-warm: if the pool is hot on average and nothing is starting, add a node before we
    //    need it (the rebalancer below then moves objects onto it).
    const active = nodes.filter((n) => n.status === "active");
    const avgLoad = active.reduce((s, n) => s + this.load(n), 0) / Math.max(1, active.length);
    if (
      active.length &&
      avgLoad >= SCALE_UP_AT &&
      !nodes.some((n) => n.status === "starting") &&
      nodes.length < cfg.maxNodes
    ) {
      this.createNode("pool hot");
    }

    // 5. Scale down: if the whole pool would fit in one fewer node with headroom, drain the emptiest.
    if (active.length > cfg.minNodes) {
      const total = active.reduce((s, n) => s + this.load(n), 0);
      const cold = total < SCALE_DOWN_BELOW * (active.length - 1);
      const emptiest = [...active].sort((a, b) => this.load(a) - this.load(b))[0];
      const since = this.lowSince(emptiest.name);
      if (!cold) {
        this.sql.exec("UPDATE nodes SET low_since = NULL WHERE status = 'active'");
      } else if (!since) {
        this.sql.exec("UPDATE nodes SET low_since = ? WHERE name = ?", now, emptiest.name);
      } else if (now - since > SCALE_DOWN_AFTER_MS) {
        await this.drainNode(emptiest.name);
      }
    }

    // 6. Rebalance: assignments are sticky, so a node that filled up before its neighbours
    //    existed stays hot. Move a batch of its objects to the coldest node.
    if (active.length > 1) {
      const sorted = [...active].sort((a, b) => this.load(b) - this.load(a));
      const hot = sorted[0], cold = sorted[sorted.length - 1];
      if (this.load(hot) > REBALANCE_HOT && this.load(hot) - this.load(cold) > REBALANCE_GAP) await this.rebalance(hot.name, cold.name);
    }

    // Garbage: forget long-stopped nodes with no assignments.
    this.sql.exec(
      "DELETE FROM nodes WHERE status = 'stopped' AND last_seen < ? AND name NOT IN (SELECT DISTINCT node FROM assignments)",
      now - 3600_000,
    );
    this.sql.exec("DELETE FROM events WHERE id < (SELECT max(id) FROM events) - 500");

    const pendingAlarm = this.sql.exec<{ at: number | null }>("SELECT min(at) AS at FROM alarms").one().at;
    if (this.nodes().some((n) => n.status !== "stopped" && n.status !== "sleeping")) {
      await this.ctx.storage.setAlarm(Math.min(now + ALARM_MS, pendingAlarm ?? Infinity));
    } else if (pendingAlarm !== null) {
      await this.ctx.storage.setAlarm(Math.max(pendingAlarm, now + 1000));
    }
  }

  // ------------------------------------------------------------------ internals

  private config() {
    const o = this.ctx.storage.kv.get<Partial<Record<"minNodes" | "maxNodes" | "maxConns", number>>>("config") ?? {};
    return {
      minNodes: o.minNodes ?? Number(this.env.POOL_MIN_NODES ?? 1),
      maxNodes: o.maxNodes ?? Number(this.env.POOL_MAX_NODES ?? 5),
      maxConns: o.maxConns ?? Number(this.env.POOL_MAX_CONNS ?? 3500),
    };
  }

  /** Runtime override of the wrangler vars (benchmarks pin the pool to N nodes this way). */
  async setConfig(c: Partial<Record<"minNodes" | "maxNodes" | "maxConns", number>>) {
    const merged = { ...(this.ctx.storage.kv.get<object>("config") ?? {}), ...c };
    this.ctx.storage.kv.put("config", merged);
    return this.config();
  }

  private nodes(): NodeRow[] {
    return this.sql
      .exec<NodeRow>(
        `SELECT n.*, (SELECT count(*) FROM assignments a WHERE a.node = n.name) AS assigned
         FROM nodes n ORDER BY n.created_at`,
      )
      .toArray();
  }

  private getNode(name: string): NodeRow | undefined {
    return this.nodes().find((n) => n.name === name);
  }

  private lowSince(name: string): number | null {
    return this.sql.exec<{ low_since: number | null }>("SELECT low_since FROM nodes WHERE name = ?", name).toArray()[0]
      ?.low_since ?? null;
  }

  /**
   * 0 = idle, 1 = full: max of connection and (smoothed) CPU pressure, plus recent assignments.
   * Memory only counts as a guard near the limit — workerd's RSS doesn't shrink after objects
   * are evicted, so as a linear signal it would keep idle nodes looking busy forever.
   */
  private load(n: NodeRow): number {
    const s: NodeStats = n.stats ? JSON.parse(n.stats) : {};
    const conns = (s.conns ?? 0) / this.config().maxConns;
    const cpu = (this.cpuEwma.get(n.name) ?? s.cpuCores ?? 0) / 0.8;
    const memFrac = s.memTotalKb ? (s.memUsedKb ?? 0) / s.memTotalKb : 0;
    const mem = memFrac > 0.75 ? memFrac / 0.85 : 0;
    const recent = (this.recent.get(n.name)?.length ?? 0) * COST_PER_RECENT_ASSIGN;
    return Math.max(conns, cpu, mem) + recent;
  }

  /**
   * Least-loaded node with headroom, preferring the caller's region; otherwise a node that's
   * already starting (in-region first); otherwise a new node in that region; at the cap, overpack.
   */
  private pickNode(exclude?: string, region?: string): string {
    const all = this.nodes()
      .filter((n) => (n.status === "active" || n.status === "starting") && n.name !== exclude)
      .map((n) => ({ n, load: this.load(n) }))
      .sort((a, b) => a.load - b.load);
    const local = region ? all.filter((c) => c.n.region === region) : all;
    const best = local[0];
    if (best && best.load < SCALE_UP_AT) return best.n.name;
    // A sleeping node beats a brand-new one: it restores from its snapshot in ~1 s.
    const asleep = this.nodes().filter((n) => n.status === "sleeping" && n.name !== exclude && (!region || n.region === region));
    if (asleep.length) return asleep[0].name;
    const startingNode = local.find((c) => c.n.status === "starting");
    if (startingNode) return startingNode.n.name;
    if (all.length < this.config().maxNodes) {
      return this.createNode(best ? `all ${region ?? ""} nodes >= ${SCALE_UP_AT}` : `first node${region ? ` in ${region}` : ""}`, region);
    }
    const fallback = all.find((c) => c.load < SCALE_UP_AT) ?? all[0];
    return fallback.n.name; // at the cap: nearest-with-room elsewhere, else overpack
  }

  private createNode(reason: string, region?: string): string {
    const next = this.sql
      .exec<{ v: number }>("INSERT INTO seq (k, v) VALUES ('node', 1) ON CONFLICT(k) DO UPDATE SET v = v + 1 RETURNING v")
      .one().v;
    const name = `node-${next}`;
    const now = Date.now();
    this.sql.exec(
      "INSERT INTO nodes (name, status, created_at, last_seen, region) VALUES (?, 'starting', ?, ?, ?)",
      name,
      now,
      now,
      region ?? null,
    );
    this.event("create", name, `${reason}${region ? ` @${region}` : ""}`);
    // The first access to a DO fixes its location: create it with the region hint.
    const stub = region
      ? this.env.POOL.get(this.env.POOL.idFromName(name), { locationHint: region as DurableObjectLocationHint })
      : this.env.POOL.getByName(name);
    this.ctx.waitUntil(
      stub
        .warm()
        .catch((e) => this.event("warm-error", name, String(e))),
    );
    return name;
  }

  private async ensureAlarm() {
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + ALARM_MS);
  }

  private event(kind: string, node: string, detail = "") {
    this.sql.exec("INSERT INTO events (at, kind, node, detail) VALUES (?, ?, ?, ?)", Date.now(), kind, node, detail);
  }
}

const short = (image: string | null) => (image ? image.split("@sha256:")[1]?.slice(0, 8) ?? image.slice(-12) : "none");

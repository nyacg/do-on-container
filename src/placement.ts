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
 */

/** suspect = stopped reporting but its container is still running (usually CPU-starved):
 *  keeps its objects, gets no new ones. Only a confirmed-dead node loses its assignments. */
type NodeStatus = "starting" | "active" | "suspect" | "draining" | "stopped";

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
    `);
  }

  // ------------------------------------------------------------------ public RPC

  /**
   * `fresh` = this object has never been placed before, so there's nothing to hydrate.
   * `epoch` = when this assignment was made; nodes use it to tell a stale request (for an
   * object they've handed off) from a new assignment back to them.
   */
  async resolve(key: string): Promise<{ node: string; fresh: boolean; epoch: number }> {
    const row = this.sql
      .exec<{ node: string; status: NodeStatus; at: number }>(
        "SELECT a.node, a.at, n.status FROM assignments a JOIN nodes n ON n.name = a.node WHERE a.key = ?",
        key,
      )
      .toArray()[0];
    // A draining node keeps its objects (answering 410) until they're persisted and released.
    if (row && row.status !== "stopped") return { node: row.node, fresh: false, epoch: row.at };
    const fresh = this.sql.exec("INSERT OR IGNORE INTO known (key) VALUES (?)", key).rowsWritten > 0;
    const node = this.pickNode();
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
      const status = existing.status === "draining" ? "draining" : "active";
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
    if (!n) return;
    // Ignore stop events while a node is still booting; the stale check catches real failures.
    if (n.status === "starting" && Date.now() - n.created_at < START_GRACE_MS) return;
    this.event("stopped", node, reason);
    // Assignments are kept: if the node restarts (rollout, crash) the objects hydrate from R2
    // on its fresh disk. If it stays down, resolve() re-places them elsewhere.
    this.sql.exec("UPDATE nodes SET status = 'stopped' WHERE name = ?", node);
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
        .then((r) => {
          const released = this.sql.exec("DELETE FROM assignments WHERE node = ?", node).rowsWritten;
          this.event("drained", node, `${released} released; ${JSON.stringify(r).slice(0, 200)}`);
        })
        .catch((e) => this.event("drain-error", node, String(e))),
    );
  }

  async addNode(): Promise<string> {
    return this.createNode("manual");
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
      location: location(n.stats),
      stats: n.stats ? JSON.parse(n.stats) : null,
    }));
    const events = this.sql
      .exec("SELECT at, kind, node, detail FROM events ORDER BY id DESC LIMIT 30")
      .toArray();
    const assignments = this.sql.exec<{ n: number }>("SELECT count(*) AS n FROM assignments").one().n;
    return { nodes, assignments, events, config: this.config(), placementVersion: this.env.VERSION?.id };
  }

  async reset(): Promise<void> {
    for (const n of this.nodes()) if (n.status !== "stopped") await this.env.POOL.getByName(n.name).shutdown().catch(() => {});
    this.sql.exec("DELETE FROM nodes; DELETE FROM assignments; DELETE FROM events; DELETE FROM known;");
  }

  // ------------------------------------------------------------------ scaling loop

  async alarm(): Promise<void> {
    const now = Date.now();
    const cfg = this.config();
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
        }
      }
    }
    // 2. Finish drains: once a draining node has no connections (or times out), stop it.
    for (const n of nodes.filter((n) => n.status === "draining")) {
      const conns = (JSON.parse(n.stats ?? "{}") as NodeStats).conns ?? 0;
      if (conns === 0 || now - (this.lowSince(n.name) ?? now) > DRAIN_TIMEOUT_MS) {
        this.sql.exec("UPDATE nodes SET status = 'stopped' WHERE name = ?", n.name);
        this.event("retire", n.name, `conns=${conns}`);
        this.ctx.waitUntil(this.env.POOL.getByName(n.name).shutdown().catch(() => {}));
      }
    }

    nodes = this.nodes().filter((n) => n.status === "active" || n.status === "starting");
    // 3. Keep the floor.
    for (let i = nodes.length; i < cfg.minNodes; i++) this.createNode("min-nodes");

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

    if (this.nodes().some((n) => n.status !== "stopped")) await this.ctx.storage.setAlarm(now + ALARM_MS);
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

  private pickNode(exclude?: string): string {
    const candidates = this.nodes()
      .filter((n) => (n.status === "active" || n.status === "starting") && n.name !== exclude)
      .map((n) => ({ n, load: this.load(n) }))
      .sort((a, b) => a.load - b.load);
    const best = candidates[0];
    if (best && best.load < SCALE_UP_AT) return best.n.name;
    const startingNode = candidates.find((c) => c.n.status === "starting");
    if (startingNode) return startingNode.n.name;
    if (candidates.length >= this.config().maxNodes) return best.n.name; // at the cap: overpack
    return this.createNode(best ? `all nodes >= ${SCALE_UP_AT}` : "first node");
  }

  private createNode(reason: string): string {
    const next = this.sql
      .exec<{ v: number }>("INSERT INTO seq (k, v) VALUES ('node', 1) ON CONFLICT(k) DO UPDATE SET v = v + 1 RETURNING v")
      .one().v;
    const name = `node-${next}`;
    const now = Date.now();
    this.sql.exec(
      "INSERT INTO nodes (name, status, created_at, last_seen) VALUES (?, 'starting', ?, ?)",
      name,
      now,
      now,
    );
    this.event("create", name, reason);
    this.ctx.waitUntil(
      this.env.POOL.getByName(name)
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

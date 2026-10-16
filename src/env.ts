import type { Conformance, CursorRoom, FacetHost, Ticker, YDoc } from "../objects";
import type { PoolNodeV2 } from "./pool-node-v2";
import type { Placement } from "./placement";

export interface Env {
  // Real Durable Objects (the control arm) — same classes that run in the pool.
  CURSORS: DurableObjectNamespace<CursorRoom>;
  DOC: DurableObjectNamespace<YDoc>;
  TICKER: DurableObjectNamespace<Ticker>;
  CONF: DurableObjectNamespace<Conformance>;
  APPS: DurableObjectNamespace<FacetHost>;
  LOADER: WorkerLoader;
  // Pool machinery
  /** v1 (prod): PoolNode on the legacy Container class. v2 (preview env): PoolNodeV2. */
  POOL: DurableObjectNamespace<PoolNodeV2>;
  PLACEMENT: DurableObjectNamespace<Placement>;
  CHECKPOINTS: R2Bucket;
  ASSETS: Fetcher;
  VERSION: WorkerVersionMetadata;
  // Tunables (wrangler vars)
  POOL_MIN_NODES: string;
  POOL_MAX_NODES: string;
  POOL_MAX_CONNS: string;
  POOL_CKPT_INTERVAL: string;
  /** v2: instance type name or JSON custom size, e.g. {"vcpu":1,"memoryMib":2048,"diskMb":4000}. */
  POOL_INSTANCE?: string;
  /** v2: "1" = place new objects in the caller's region (DO location hints). */
  POOL_REGIONS?: string;
  /** v2: idle time before a node snapshots itself and stops (0 = never). */
  POOL_SLEEP_AFTER_MS?: string;
  ADMIN_TOKEN?: string;
}

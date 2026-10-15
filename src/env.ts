import type { CursorRoom, Ticker, YDoc } from "../objects";
import type { PoolNode } from "./pool-node";
import type { Placement } from "./placement";

export interface Env {
  // Real Durable Objects (the control arm) — same classes that run in the pool.
  CURSORS: DurableObjectNamespace<CursorRoom>;
  DOC: DurableObjectNamespace<YDoc>;
  TICKER: DurableObjectNamespace<Ticker>;
  // Pool machinery
  POOL: DurableObjectNamespace<PoolNode>;
  PLACEMENT: DurableObjectNamespace<Placement>;
  CHECKPOINTS: R2Bucket;
  ASSETS: Fetcher;
  VERSION: WorkerVersionMetadata;
  // Tunables (wrangler vars)
  POOL_MIN_NODES: string;
  POOL_MAX_NODES: string;
  POOL_MAX_CONNS: string;
  POOL_CKPT_INTERVAL: string;
}

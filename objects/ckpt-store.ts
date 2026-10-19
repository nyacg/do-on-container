/**
 * Segment-based checkpoint store for pooled objects (R2 via the bridge).
 *
 * Writing one R2 object per Durable Object per flush costs a Class A op each
 * ($4.50/M): 1000 always-busy objects flushed every 5 minutes is ~$39/month — more than the
 * container. Instead each flush writes:
 *
 *   seg/<node>/<ts>      all dirty snapshots concatenated (one PUT)
 *   manifest/<node>      key → [segment, offset, length, at, alarm] for every object this node has
 *                        checkpointed (one PUT)
 *
 * Hydration looks a key up across all node manifests (newest `at` wins) and does a ranged
 * GET into the segment. Segments are never rewritten; old ones can be expired once a
 * compaction job carries live entries forward (not implemented — storage is $0.015/GB-month).
 */
import { maxSnapshotBytes, type PoolEnv } from "./portable";

export const BRIDGE_ORIGIN = "http://bridge.internal";

export function bridgeFetch(env: PoolEnv, path: string, init?: RequestInit) {
  const url = BRIDGE_ORIGIN + path;
  return env.__BRIDGE ? env.__BRIDGE.fetch(url, init) : fetch(url, init);
}

/** `alarm` = the object's pending alarm when it was checkpointed (lets Placement recover alarms
 *  of objects on a node that died without draining). */
export type Entry = [seg: string, off: number, len: number, at: number, alarm?: number | null];
interface Manifest {
  node: string;
  entries: Record<string, Entry>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Plain data only (shared by every object in the process; no cross-request promises). */
const cache = {
  loadedAt: 0,
  /** When the last *completed* manifest load started. */
  loadStartedAt: 0,
  /** When the in-flight load started (0 = none). */
  loadingSince: 0,
  merged: new Map<string, Entry>(),
  own: null as Manifest | null,
};

export async function loadManifests(env: PoolEnv): Promise<number> {
  const res = await bridgeFetch(env, "/list?prefix=manifest/");
  if (!res.ok) throw new Error(`list manifests: ${res.status}`);
  const keys = (await res.json()) as string[];
  const merged = new Map<string, Entry>();
  await Promise.all(
    keys.map(async (k) => {
      const r = await bridgeFetch(env, `/blob/${k}`);
      if (!r.ok) return;
      const m = (await r.json()) as Manifest;
      for (const [key, e] of Object.entries(m.entries)) {
        const cur = merged.get(key);
        if (!cur || cur[3] < e[3]) merged.set(key, e);
      }
    }),
  );
  // Never let a reload drop entries we wrote ourselves since the last load.
  for (const [key, e] of cache.merged) {
    const cur = merged.get(key);
    if (!cur || cur[3] < e[3]) merged.set(key, e);
  }
  cache.merged = merged;
  cache.loadedAt = Date.now();
  return keys.length;
}

/**
 * Latest snapshot bytes for `key`, or null if it has never been checkpointed.
 *
 * Only trusts a manifest load that *started after* this call: an object can have moved
 * node → elsewhere → back here, and our cached view would point at the stale first copy.
 * Concurrent hydrations (a node restarting with 1000 objects) share one load.
 */
export async function readSnapshot(env: PoolEnv, key: string): Promise<ArrayBuffer | null> {
  const asOf = Date.now();
  while (cache.loadStartedAt < asOf) {
    if (cache.loadingSince >= asOf) {
      await sleep(20); // someone else's fresh-enough load is in flight
      continue;
    }
    if (cache.loadingSince && Date.now() - cache.loadingSince < 10_000) {
      await sleep(20); // a stale load is in flight; wait for it, then start ours
      continue;
    }
    const started = (cache.loadingSince = Date.now());
    try {
      await loadManifests(env);
      cache.loadStartedAt = started;
    } finally {
      cache.loadingSince = 0;
    }
  }
  const e = cache.merged.get(key);
  if (!e) return null;
  const [seg, off, len] = e;
  // Never pull an oversized snapshot onto a node (one written before the cap, or with a
  // different cap): fail the wake loudly instead of filling memory and disk.
  if (len > maxSnapshotBytes(env)) throw new Error(`${key}: checkpoint is ${(len / 1048576).toFixed(1)} MB, over the snapshot cap; refusing to hydrate`);
  const res = await bridgeFetch(env, `/blob/${seg}`, { headers: { range: `bytes=${off}-${off + len - 1}` } });
  if (!res.ok) throw new Error(`read ${key} from ${seg}: ${res.status}`);
  return res.arrayBuffer();
}

/** Write one segment with every snapshot, then publish this node's updated manifest. */
export async function writeSegment(
  env: PoolEnv,
  node: string,
  items: { key: string; bytes: ArrayBuffer; alarm?: number | null }[],
): Promise<{ seg: string; bytes: number }> {
  if (!cache.own) {
    const r = await bridgeFetch(env, `/blob/manifest/${node}`);
    cache.own = r.ok ? ((await r.json()) as Manifest) : { node, entries: {} };
  }
  const at = Date.now();
  const seg = `seg/${node}/${at}-${Math.random().toString(36).slice(2, 8)}`;
  const total = items.reduce((s, i) => s + i.bytes.byteLength, 0);
  const body = new Uint8Array(total);
  const entries: [string, Entry][] = [];
  let off = 0;
  for (const { key, bytes, alarm } of items) {
    body.set(new Uint8Array(bytes), off);
    entries.push([key, [seg, off, bytes.byteLength, at, alarm ?? null]]);
    off += bytes.byteLength;
  }
  const put = await bridgeFetch(env, `/blob/${seg}`, { method: "PUT", body });
  if (!put.ok) throw new Error(`segment put: ${put.status}`);
  for (const [key, e] of entries) {
    cache.own.entries[key] = e;
    cache.merged.set(key, e);
  }
  const m = await bridgeFetch(env, `/blob/manifest/${node}`, { method: "PUT", body: JSON.stringify(cache.own) });
  if (!m.ok) throw new Error(`manifest put: ${m.status}`);
  return { seg, bytes: total };
}

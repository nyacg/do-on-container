import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { loadPool, objectContext, deferred } from "./helpers/local-pool";

const { edge, router, rpc, Placement, PortableDurableObject, poolRegistry, encode, decode, gunzip } = await loadPool();
const blobs = new Map<string, ArrayBuffer>();
const bridge = {
  async fetch(url: string, init?: RequestInit) {
    const key = new URL(url).pathname.slice("/blob/".length);
    if (init?.method === "PUT") {
      blobs.set(key, await new Response(init.body).arrayBuffer());
      return new Response("ok");
    }
    return blobs.has(key) ? new Response(blobs.get(key)) : new Response("missing", { status: 404 });
  },
};
const env: any = { NODE_NAME: "test-node", __BRIDGE: bridge };
const namespace = (objects: Record<string, any>) => ({ idFromName: (name: string) => name, get: (name: string) => objects[name] });
const route = (req: Request) => router.fetch(req, env);
const admin = (path: string, body?: unknown) => route(new Request(`http://node/${path}`, {
  method: "POST", body: body === undefined ? undefined : JSON.stringify(body),
}));
const request = (name: string, call?: string) => new Request("http://object/op", {
  method: "POST",
  headers: { "x-do-class": "conf", "x-do-name": name, "x-do-epoch": "1", ...(call ? { "x-do-call": "1" } : {}) },
  body: JSON.stringify(call ? { chain: [{ call, args: [] }] } : {}),
});

beforeEach(async () => {
  await admin("__undrain");
  for (const field of ["live", "dirty", "alarmed", "fresh", "epochs"]) poolRegistry[field].clear();
});

function controlEnv() {
  return {
    PLACEMENT: { getByName: () => ({ resolve: async () => ({ node: "test-node", fresh: false, epoch: 1 }) }) },
    POOL: { getByName: () => ({ fetch: (input: string | Request, init?: RequestInit) => route(new Request(input, init)) }) },
  };
}

test("public HTTP cannot select lifecycle RPC, while internal RPC still works", async () => {
  let retired = false;
  let fetched = 0;
  env.CONF = namespace({ boundary: {
    poolRetire: async () => { retired = true; },
    ping: async () => "pong",
    fetch: async (req: Request) => {
      fetched++;
      assert.equal(req.headers.get("x-do-call"), null);
      return new Response("application fetch");
    },
  } });
  const publicRequest = new Request("https://edge/pool/conf/boundary", {
    method: "POST", headers: { "X-Do-Call": "1" },
    body: JSON.stringify({ chain: [{ call: "poolRetire", args: [] }] }),
  });
  assert.equal(await (await edge.fetch(publicRequest, controlEnv())).text(), "application fetch");
  assert.equal(retired, false);

  const invoke = async (last: any) => rpc(new Request("http://bridge/rpc", {
    method: "POST", body: JSON.stringify({ binding: "CONF", chain: [{ call: "getByName", args: ["boundary"] }, last] }),
  }), controlEnv());
  const internal = await invoke({ call: "ping", args: [] });
  assert.deepEqual(await internal.json(), { ok: "pong" });
  const forwarded = new Request("http://object/op", {
    method: "POST", headers: { "x-do-call": "1" }, body: JSON.stringify({ chain: [{ call: "poolRetire", args: [] }] }),
  });
  const fetchResult = await invoke({ call: "fetch", args: await encode([forwarded]) });
  assert.equal(await decode((await fetchResult.json()).ok).text(), "application fetch");
  assert.equal(retired, false);
  assert.equal(fetched, 2);
});

test("eviction waits for an RPC awaiting I/O and persists its acknowledged write", async (t) => {
  const entered = deferred();
  const release = deferred();
  const ctx = objectContext("slow-rpc");
  t.after(() => ctx.close());
  class SlowObject extends PortableDurableObject {
    static slug = "conf";
    async mutate() {
      entered.resolve();
      await release.promise;
      this.ctx.storage.kv.put("acknowledged", 1);
      return "ok";
    }
  }
  poolRegistry.fresh.add("conf/slow-rpc");
  const object = new SlowObject(ctx, { __DO_POOL: "1" });
  await ctx.settle();
  env.CONF = namespace({ "slow-rpc": object });
  const pending = route(request("slow-rpc", "mutate"));
  await entered.promise;
  let finished = false;
  const eviction = admin("__evict", [{ key: "conf/slow-rpc", epoch: 1 }]).then(async (r: Response) => {
    finished = true;
    return r.json();
  });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(finished, false);
  assert.equal((await route(request("slow-rpc", "mutate"))).status, 410);
  release.resolve();
  assert.deepEqual(await (await pending).json(), { ok: "ok" });
  const moved = await eviction;
  assert.deepEqual(moved.evictedKeys, ["conf/slow-rpc"]);
  const snapshot = JSON.parse(await gunzip(blobs.get(moved.seg)));
  assert.deepEqual(snapshot.kv, [["acknowledged", 1]]);
  assert.equal(ctx.storage.kv.get("acknowledged"), undefined, "old copy retired after persistence");
});

function stub(overrides: Record<string, unknown> = {}) {
  return {
    poolClose: async () => {}, poolUnfreeze: async () => {}, poolRetire: async () => {},
    poolSnapshot: async () => ({ bytes: new Uint8Array([1]).buffer, alarm: null }),
    fetch: async () => new Response("still serving"),
    ...overrides,
  };
}

test("a failed snapshot keeps its local object while successful keys retire", async () => {
  const retired: string[] = [];
  const unfrozen: string[] = [];
  env.CONF = namespace({
    good: stub({ poolRetire: async () => retired.push("good") }),
    bad: stub({
      poolSnapshot: async () => { throw new Error("snapshot failure"); },
      poolRetire: async () => retired.push("bad"),
      poolUnfreeze: async () => unfrozen.push("bad"),
    }),
  });
  const result = await (await admin("__evict", ["good", "bad"].map((name) => ({ key: `conf/${name}`, epoch: 1 })))).json();
  assert.deepEqual(result.evictedKeys, ["conf/good"]);
  assert.deepEqual(retired, ["good"]);
  assert.deepEqual(unfrozen, ["bad"]);
  assert.equal(poolRegistry.dirty.has("conf/bad"), true);
  assert.equal((await route(request("good"))).status, 410);
  assert.equal((await route(request("bad"))).status, 200);
});

test("a failed close never checkpoints or retires the object", async () => {
  env.CONF = namespace({ busy: stub({
    poolClose: async () => { throw new Error("still busy"); },
    poolSnapshot: async () => assert.fail("must not snapshot an unfrozen object"),
    poolRetire: async () => assert.fail("must not retire an unfrozen object"),
  }) });
  const result = await (await admin("__evict", [{ key: "conf/busy", epoch: 1 }])).json();
  assert.deepEqual(result.evictedKeys, []);
  assert.equal((await route(request("busy"))).status, 200);
});

test("an RPC exceeding the handoff deadline aborts the move without taking a snapshot", async (t) => {
  const entered = deferred();
  const release = deferred();
  t.after(() => release.resolve());
  let unfrozen = false;
  env.CONF = namespace({ timeout: stub({
    mutate: async () => { entered.resolve(); await release.promise; return "acknowledged"; },
    poolClose: async () => assert.fail("must not close while RPC is pending"),
    poolSnapshot: async () => assert.fail("must not snapshot while RPC is pending"),
    poolUnfreeze: async () => { unfrozen = true; },
    poolRetire: async () => assert.fail("must not retire while RPC is pending"),
  }) });
  const pending = route(request("timeout", "mutate"));
  await entered.promise;
  const result = await (await admin("__evict", [{ key: "conf/timeout", epoch: 1 }])).json();
  assert.deepEqual(result.evictedKeys, []);
  assert.equal(result.seg, null);
  assert.match(result.errors[0], /in-flight/);
  assert.equal(unfrozen, true);
  release.resolve();
  assert.deepEqual(await (await pending).json(), { ok: "acknowledged" });
  assert.equal((await route(request("timeout"))).status, 200);
});

test("failed checkpoint upload retires no objects and transfers no alarms", async (t) => {
  const oldBridge = env.__BRIDGE;
  t.after(() => { env.__BRIDGE = oldBridge; });
  env.__BRIDGE = { fetch: async () => new Response("unavailable", { status: 503 }) };
  let unfrozen = false;
  env.CONF = namespace({ upload: stub({
    poolSnapshot: async () => ({ bytes: new Uint8Array([1]).buffer, alarm: 123 }),
    poolRetire: async () => assert.fail("must not retire without a durable checkpoint"),
    poolUnfreeze: async () => { unfrozen = true; },
  }) });
  const result = await (await admin("__evict", [{ key: "conf/upload", epoch: 1 }])).json();
  assert.deepEqual(result.evictedKeys, []);
  assert.deepEqual(result.alarms, []);
  assert.equal(unfrozen, true);
  assert.equal((await route(request("upload"))).status, 200);
});

test("mixed tenant eviction retains successful keys even when another tenant throws", async () => {
  const ready = new Map<string, string>();
  env.SPAWNQ = { fetch: async (url: string, init: RequestInit) => {
    const slot = new URL(url).pathname.slice(1);
    const [app, nonce] = String(init.body).split(" ");
    ready.set(slot, nonce);
    env[`SLOT${slot}`] = { fetch: async () => {
      if (app === "unreachable") throw new Error("tenant socket closed");
      if (app === "failed") return Response.json({ evicted: 0, evictedKeys: [], errors: ["checkpoint failed"] });
      return Response.json({ evicted: 1, evictedKeys: ["app/ok:one"], alarms: [{ key: "app/ok:one", at: 123 }] });
    } };
    return new Response("ok");
  } };
  env.SLOTS = { fetch: async (url: string) => new Response(ready.get(new URL(url).pathname.split("/")[1])) };
  const result = await (await admin("__evict", ["ok", "failed", "unreachable"].map((app) => ({ key: `sapp/${app}:one`, epoch: 1 })))).json();
  assert.deepEqual(result.evictedKeys, ["sapp/ok:one"]);
  assert.deepEqual(result.alarms, [{ key: "sapp/ok:one", at: 123 }]);
  assert.equal(result.errors.length, 2);
  const sapp = (app: string) => new Request("http://object/", { headers: { "x-do-class": "sapp", "x-do-name": `${app}:one`, "x-do-epoch": "1" } });
  assert.equal((await route(sapp("ok"))).status, 410);
  assert.equal((await route(sapp("failed"))).status, 200);
  assert.equal((await route(sapp("unreachable"))).status, 410, "unknown outcome remains fenced until retry");
});

function placementFixture(t: any, response: any) {
  const ctx = objectContext();
  t.after(() => ctx.close());
  const placement = new Placement(ctx, {
    POOL: { getByName: () => ({ evict: async () => response, shutdown: async () => {} }) },
    POOL_MIN_NODES: "0", POOL_MAX_NODES: "2", POOL_MAX_CONNS: "3500",
  });
  for (const node of ["old", "new"]) {
    ctx.storage.sql.exec("INSERT INTO nodes (name, status, created_at, last_seen) VALUES (?, 'active', ?, ?)", node, Date.now(), Date.now());
  }
  for (const key of ["sapp/ok:one", "sapp/failed:one"]) {
    ctx.storage.sql.exec("INSERT INTO assignments (key, node, at) VALUES (?, 'old', 1)", key);
  }
  const owner = (key: string) => ctx.storage.sql.exec("SELECT node FROM assignments WHERE key = ?", key).one().node;
  return { ctx, placement, owner };
}

for (const mode of ["rebalance", "rollout"]) {
  test(`${mode} changes only confirmed assignments and registers only their alarms`, async (t) => {
    const { ctx, placement, owner } = placementFixture(t, {
      evicted: 1, evictedKeys: ["sapp/ok:one"],
      alarms: [{ key: "sapp/ok:one", at: 123 }, { key: "sapp/failed:one", at: 456 }],
    });
    if (mode === "rollout") {
      ctx.storage.sql.exec("UPDATE nodes SET status = 'retiring' WHERE name = 'old'");
      await placement.progressRollout();
    } else await placement.rebalance("old", "new");
    assert.equal(owner("sapp/ok:one"), "new");
    assert.equal(owner("sapp/failed:one"), "old");
    assert.deepEqual(ctx.storage.sql.exec("SELECT key FROM alarms").toArray().map((r) => r.key), ["sapp/ok:one"]);
  });
}

test("legacy partial counts cannot reassign an unidentified subset", async (t) => {
  const { placement, owner } = placementFixture(t, { evicted: 1 });
  await placement.rebalance("old", "new");
  assert.equal(owner("sapp/ok:one"), "old");
  assert.equal(owner("sapp/failed:one"), "old");
});

test("failed drains retain assignments and retry before shutting down", async (t) => {
  const { ctx, placement, owner } = placementFixture(t, { evicted: 0 });
  let failed = 1;
  let drains = 0;
  let stops = 0;
  placement.env.POOL = { getByName: () => ({
    drain: async () => { drains++; return { failed, alarms: [], errors: failed ? ["busy"] : [] }; },
    shutdown: async () => { stops++; },
  }) };
  await placement.drainNode("old");
  await ctx.settle();
  assert.equal(owner("sapp/ok:one"), "old");
  await placement.alarm();
  await ctx.settle();
  assert.equal(drains, 2);
  assert.equal(stops, 0);
  assert.equal(owner("sapp/ok:one"), "old");
  failed = 0;
  await placement.alarm();
  await ctx.settle();
  assert.equal(ctx.storage.sql.exec("SELECT count(*) AS n FROM assignments WHERE node = 'old'").one().n, 0);
  await placement.alarm();
  await ctx.settle();
  assert.equal(stops, 1);
});

for (const rootExists of [false, true]) {
  test(`node death recovers paginated sandbox alarms (main manifest ${rootExists ? "present" : "absent"})`, async (t) => {
    const ctx = objectContext();
    t.after(() => ctx.close());
    const at = Date.now() + 60_000;
    const entry = (alarm: number | null) => ["seg/x", 0, 1, 100, alarm];
    const manifests: Record<string, any> = {
      "manifest/node-1--t--first": { entries: { "app/first:one": entry(at), "app/first:moved": entry(at), "app/first:cancelled": entry(null) } },
      "manifest/node-1--t--second": { entries: { "app/second:one": entry(at), "app/foreign:one": entry(at) } },
    };
    if (rootExists) manifests["manifest/node-1"] = { entries: { "conf/plain": entry(at) } };
    const cursors: unknown[] = [];
    const placement = new Placement(ctx, {
      CHECKPOINTS: {
        list: async ({ prefix, cursor }: any) => {
          assert.equal(prefix, "manifest/node-1--t--");
          cursors.push(cursor);
          return cursor
            ? { objects: [{ key: `${prefix}second` }], truncated: false }
            : { objects: [{ key: `${prefix}first` }], truncated: true, cursor: "page-2" };
        },
        get: async (key: string) => manifests[key] ? { json: async () => manifests[key] } : null,
      },
    });
    ctx.storage.sql.exec("INSERT INTO nodes (name, status, created_at, last_seen) VALUES ('node-1', 'active', 0, 0)");
    for (const key of ["conf/plain", "sapp/first:one", "sapp/first:cancelled", "sapp/second:one", "sapp/foreign:one"]) {
      ctx.storage.sql.exec("INSERT INTO assignments (key, node, at) VALUES (?, 'node-1', 1)", key);
    }
    ctx.storage.sql.exec("INSERT INTO assignments (key, node, at) VALUES ('sapp/first:moved', 'node-2', 2)");
    await placement.nodeStopped("node-1", "killed");
    assert.deepEqual(cursors, [undefined, "page-2"]);
    const keys = ctx.storage.sql.exec("SELECT key FROM alarms ORDER BY key").toArray().map((r) => r.key);
    assert.deepEqual(keys, [...(rootExists ? ["conf/plain"] : []), "sapp/first:one", "sapp/second:one"]);
    assert.ok((await ctx.storage.getAlarm())! <= at);
  });
}

// ---------------------------------------------------------------- snapshot size cap

class CacheyObject extends PortableDurableObject {
  static slug = "conf";
  protected poolSnapshotExclude() {
    return ["page_cache"];
  }
  onStart() {
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, body TEXT)");
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS page_cache (id INTEGER PRIMARY KEY, data TEXT)");
  }
}

test("cache tables are left out of checkpoints, their schema kept", async () => {
  const ctx = objectContext("cachey");
  poolRegistry.fresh.add("conf/cachey"); // brand-new: nothing to hydrate
  const obj = new CacheyObject(ctx as any, { ...env, __DO_POOL: "1" });
  await ctx.settle();
  ctx.storage.sql.exec("INSERT INTO notes VALUES ('a', 'keep me')");
  for (let i = 0; i < 50; i++) ctx.storage.sql.exec("INSERT INTO page_cache VALUES (?, ?)", i, "x".repeat(1000));
  const { bytes } = await obj.poolSnapshot();
  const snap = JSON.parse(await gunzip(bytes));
  const table = (n: string) => snap.tables.find((t: any) => t.name === n);
  assert.deepEqual(table("notes").rows.length, 1);
  assert.deepEqual(table("page_cache").rows, []);
  assert.ok(snap.schema.some((s: any) => s.name === "page_cache"), "schema still recreates the table");
});

test("an oversized snapshot fails loudly and leaves the object dirty", async () => {
  const ctx = objectContext("huge");
  poolRegistry.fresh.add("conf/huge");
  const obj = new CacheyObject(ctx as any, { ...env, __DO_POOL: "1", POOL_MAX_SNAPSHOT_MB: "0.01" });
  await ctx.settle();
  // Incompressible: ~100 KB of random hex against a 10 KB cap.
  for (let i = 0; i < 100; i++) ctx.storage.sql.exec("INSERT INTO notes VALUES (?, ?)", `n${i}`, Array.from(crypto.getRandomValues(new Uint8Array(512)), (b) => b.toString(16).padStart(2, "0")).join(""));
  await assert.rejects(obj.poolSnapshot(), /over the 0\.0 MB snapshot cap|over the .* MB snapshot cap/);
  assert.equal(poolRegistry.dirty.has("conf/huge"), true);
});

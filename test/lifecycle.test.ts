/**
 * Pool lifecycle guarantees (v2 preview deployment). Slow: minutes per test.
 *
 *   BASE=https://do-pool-v2.do-pool-lab.workers.dev ADMIN_TOKEN=... npm run test:lifecycle
 *   ONLY=alarm-migrate,... to run a subset.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";

const BASE = process.env.BASE ?? "https://do-pool-v2.do-pool-lab.workers.dev";
const TOKEN = process.env.ADMIN_TOKEN!;
const RUN = Date.now().toString(36);
const ONLY = process.env.ONLY?.split(",");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function get(url: string, init?: RequestInit): Promise<Response> {
  for (let i = 0; ; i++) {
    try {
      return await fetch(url, init);
    } catch (e) {
      if (i >= 5) throw e;
      await sleep(1000);
    }
  }
}

function obj(name: string) {
  const full = `${RUN}-${name}`;
  const base = `${BASE}/pool/conf/${full}`;
  return {
    key: `conf/${full}`,
    async op<T = any>(op: string, params: Record<string, string | number> = {}): Promise<T & { node: string }> {
      const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
      for (let attempt = 0; ; attempt++) {
        const res = await get(`${base}/${op}?${qs}`);
        const text = await res.text();
        if (!text.startsWith("{") && attempt < 20) {
          await sleep(1500); // node restarting / object moving
          continue;
        }
        const body = JSON.parse(text);
        assert.equal(body.error, undefined, `${op}: ${body.error}`);
        return { ...body, node: res.headers.get("x-pool-node") };
      }
    },
    wsUrl: `${base.replace(/^http/, "ws")}/ws`,
  };
}

async function admin(path: string) {
  const res = await get(`${BASE}/api/${path}`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } });
  const text = await res.text();
  assert.ok(res.ok, `${path}: ${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

async function status() {
  return (await (await get(`${BASE}/api/status`)).json()) as any;
}

async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, timeoutMs: number, every = 2000): Promise<T> {
  const t0 = Date.now();
  let v = await fn();
  while (!ok(v) && Date.now() - t0 < timeoutMs) {
    await sleep(every);
    v = await fn();
  }
  return v;
}

const run = (name: string, fn: () => Promise<void>) =>
  test(name, { skip: ONLY && !ONLY.includes(name) ? "not selected" : false, timeout: 15 * 60_000 }, fn);

/** Fired-alarm log of an object, read without disturbing timing (one request). */
async function fired(o: ReturnType<typeof obj>) {
  return (await o.op<{ fired: { at: number }[] }>("alarm/fired")).fired;
}

run("ensure-two-nodes", async () => {
  await admin("config?minNodes=2&maxNodes=4");
  // A sleeping node counts towards the floor (Placement wakes it on the first request to it).
  const up = (s: any) => s.nodes.filter((n: any) => n.status === "active" || n.status === "sleeping").length >= 2;
  const s = await waitFor(status, up, 180_000, 5000);
  assert.ok(up(s), JSON.stringify(s.nodes.map((n: any) => [n.name, n.status])));
});

run("alarm-migrate", async () => {
  // An object with a pending alarm and no clients moves to another node; the alarm still fires.
  const o = obj("alarm-migrate");
  const { node } = await o.op("sql/put", { k: "a", v: "1" });
  const { at } = await o.op("alarm/set", { ms: 25_000 });
  const moved = await admin(`migrate?key=${encodeURIComponent(o.key)}`);
  assert.notEqual(moved.node, node, "migrated to a different node");
  await sleep(at - Date.now() + 15_000); // no requests until well after it was due
  const f = await fired(o);
  assert.equal(f.length, 1, `fired ${f.length} times`);
  assert.ok(f[0].at >= at && f[0].at - at < 15_000, `fired ${f[0].at - at}ms after due`);
  assert.equal((await o.op("sql/get", { k: "a" })).v, "1");
});

run("alarm-sigterm", async () => {
  // Node gets SIGTERM (rollout / scale-down path): drain hands the alarm to Placement.
  const o = obj("alarm-sigterm");
  const { node } = await o.op("sql/put", { k: "a", v: "1" });
  const { at } = await o.op("alarm/set", { ms: 40_000 });
  await admin(`stop-node?node=${node}`);
  await sleep(at - Date.now() + 20_000);
  const f = await fired(o);
  assert.equal(f.length, 1, `fired ${f.length} times`);
  assert.ok(f[0].at - at < 20_000, `fired ${f[0].at - at}ms after due`);
});

run("alarm-sigkill", async () => {
  // Host failure, no drain: the alarm is recovered from the node's last checkpoint manifest.
  const o = obj("alarm-sigkill");
  const { node } = await o.op("sql/put", { k: "a", v: "1" });
  const { at } = await o.op("alarm/set", { ms: 90_000 });
  await sleep(40_000); // let a periodic flush (30 s) checkpoint it
  await admin(`kill-node?node=${node}`);
  await sleep(at - Date.now() + 30_000);
  const f = await fired(o);
  assert.equal(f.length, 1, `fired ${f.length} times`);
  assert.ok(f[0].at - at < 30_000, `fired ${f[0].at - at}ms after due`);
  assert.equal((await o.op("sql/get", { k: "a" })).v, "1");
});

run("migrate-under-writes", async () => {
  // Writes over a WebSocket-free HTTP loop while the object is moved back and forth.
  const o = obj("mig");
  await o.op("sql/put", { k: "seed", v: "0" });
  let acked = 0;
  let stop = false;
  const writer = (async () => {
    for (let i = 0; !stop; i++) {
      await o.op("sql/put", { k: `w${i}`, v: String(i) });
      acked++;
    }
  })();
  const path: string[] = [];
  for (let i = 0; i < 4; i++) {
    await sleep(4000);
    path.push((await admin(`migrate?key=${encodeURIComponent(o.key)}`)).node);
  }
  await sleep(3000);
  stop = true;
  await writer;
  const n = (await o.op("sql/count")).n;
  assert.equal(n, acked + 1, `persisted ${n - 1} of ${acked} acknowledged writes; path ${path.join(" → ")}`);
});

run("websocket-reconnects-after-move", async () => {
  const o = obj("wsmove");
  await o.op("sql/put", { k: "a", v: "1" });
  const ws = new WebSocket(o.wsUrl, { perMessageDeflate: false });
  await new Promise((r, j) => (ws.once("open", r), ws.once("error", j)));
  const closed = new Promise<number>((r) => ws.once("close", (c) => r(c)));
  await admin(`migrate?key=${encodeURIComponent(o.key)}`);
  assert.equal(await closed, 1012, "clients are told to reconnect (1012 service restart)");
  const ws2 = new WebSocket(o.wsUrl, { perMessageDeflate: false });
  await new Promise((r, j) => (ws2.once("open", r), ws2.once("error", j)));
  ws2.send("echo:back");
  const msg = await new Promise((r) => ws2.once("message", (d) => r(String(d))));
  assert.equal(msg, "echo:back");
  ws2.close();
});

run("control-deploy-under-load", async () => {
  // Under scheduling_policy "durable_object" a container lives and dies with its DO, so a deploy
  // of the control-plane Worker (new node code or a new container image) restarts every node.
  // Check that such a deploy, mid-traffic, loses nothing: data, acknowledged writes, an alarm.
  const { execSync } = await import("node:child_process");
  const objs = Array.from({ length: 30 }, (_, i) => obj(`cd-${i}`));
  await Promise.all(objs.map((o, i) => o.op("sql/put", { k: "v", v: String(i) })));
  const alarmObj = obj("cd-alarm");
  const { at } = await alarmObj.op("alarm/set", { ms: 6 * 60_000 });
  const before = new Set((await status()).nodes.filter((n: any) => n.status === "active").map((n: any) => n.name));
  const writerObj = obj("cd-writer");
  let acked = 0;
  let stop = false;
  let maxGapMs = 0;
  const writer = (async () => {
    for (let i = 0; !stop; i++) {
      const t0 = Date.now();
      await writerObj.op("sql/put", { k: `w${i}`, v: String(i) });
      maxGapMs = Math.max(maxGapMs, Date.now() - t0);
      acked++;
    }
  })();

  const t0 = Date.now();
  execSync("npm run deploy:control", { stdio: "ignore", env: process.env });
  const deployedMs = Date.now() - t0;
  // Wait until every pre-deploy node is gone and traffic has flowed for a while after.
  await waitFor(status, (s) => !s.nodes.some((n: any) => before.has(n.name) && n.status === "active"), 12 * 60_000, 10_000);
  const replacedMs = Date.now() - t0;
  await sleep(20_000);
  stop = true;
  await writer;

  const values = await Promise.all(objs.map((o) => o.op("sql/get", { k: "v" })));
  assert.deepEqual(values.map((v) => v.v), objs.map((_, i) => String(i)));
  const n = (await writerObj.op("sql/count")).n;
  console.log(JSON.stringify({ deployedMs, replacedMs, acked, persisted: n, maxWriteGapMs: maxGapMs }));
  assert.equal(n, acked, `persisted ${n} of ${acked} acknowledged writes`);

  await sleep(Math.max(0, at - Date.now()) + 30_000);
  const f = await fired(alarmObj);
  assert.equal(f.length, 1, `alarm fired ${f.length} times`);
});

run("sleep-wake", async () => {
  // An idle node snapshots its filesystem and stops; a request wakes it from the snapshot, and a
  // due alarm on a sleeping node is fired via Placement's registry.
  const o = obj("sleepy");
  const { node } = await o.op("sql/put", { k: "a", v: "1" });
  const { at } = await o.op("alarm/set", { ms: 150_000 });
  const r = await admin(`sleep-node?node=${node}`);
  assert.equal(r.slept, true, JSON.stringify(r));
  const s = await status();
  assert.equal(s.nodes.find((n: any) => n.name === node)?.status, "sleeping");
  const info1 = await (await get(`${BASE}/api/node/${node}/info`)).json();
  assert.equal(info1.running, false);
  assert.ok(info1.snapshot?.id, "snapshot recorded");
  // No requests: the alarm must wake the node by itself.
  await sleep(at - Date.now() + 25_000);
  const info2 = await (await get(`${BASE}/api/node/${node}/info`)).json();
  assert.equal(info2.running, true, "alarm registry woke the node");
  assert.equal(info2.lastStart?.fromSnapshot, true, "restored from the snapshot");
  const f = await fired(o);
  assert.equal(f.length, 1, `alarm fired ${f.length} times`);
  assert.ok(f[0].at - at < 25_000, `fired ${f[0].at - at}ms late`);
  assert.equal((await o.op("sql/get", { k: "a" })).v, "1");
  console.log(JSON.stringify({ sleep: r, wakeReadyMs: info2.lastStart?.readyMs }));
});

function app(name: string) {
  const o = obj(name);
  const full = `conf:${RUN}-${name}`;
  const base = `${BASE}/pool/app/${full}`;
  return {
    key: `app/${full}`,
    async op<T = any>(op: string, params: Record<string, string | number> = {}) {
      const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
      for (let attempt = 0; ; attempt++) {
        const res = await get(`${base}/${op}?${qs}`);
        const text = await res.text();
        if (!text.startsWith("{") && attempt < 20) {
          await sleep(1500);
          continue;
        }
        const body = JSON.parse(text);
        assert.equal(body.error, undefined, `${op}: ${body.error}`);
        return { ...body, node: res.headers.get("x-pool-node") } as T & { node: string };
      }
    },
    wsUrl: `${base.replace(/^http/, "ws")}/ws`,
    _o: o,
  };
}

run("facet-migrate", async () => {
  // A pooled facet (dynamically loaded app) moves between nodes with its own database and its
  // (proxied) alarm intact.
  const a = app("fmig");
  const { node } = await a.op("sql/put", { k: "a", v: "facet-data" });
  await a.op("kv/put", { k: "x", v: JSON.stringify({ n: 1 }) });
  const { at } = await a.op("alarm/set", { ms: 30_000 });
  const moved = await admin(`migrate?key=${encodeURIComponent(a.key)}`);
  assert.notEqual(moved.node, node);
  assert.equal((await a.op("sql/get", { k: "a" })).v, "facet-data");
  assert.deepEqual((await a.op("kv/get", { k: "x" })).v, { n: 1 });
  assert.equal((await a.op("alarm/get")).at, at);
  await sleep(at - Date.now() + 15_000);
  const f = (await a.op("alarm/fired")).fired;
  assert.equal(f.length, 1, `alarm fired ${f.length} times`);
});

run("facet-code-swap", async () => {
  // Publishing new app code hot-swaps running facets: data kept, sockets told to reconnect.
  const a = app("fswap");
  await a.op("sql/put", { k: "a", v: "v1-data" });
  const ws = new WebSocket(a.wsUrl, { perMessageDeflate: false });
  await new Promise((r, j) => (ws.once("open", r), ws.once("error", j)));
  const closed = new Promise<number>((r) => ws.once("close", (c) => r(c)));
  // New code = conformance app + a marker, published under the same app id.
  const builtin = await (await get(`${BASE}/api/code?app=conf&builtin=conformance`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } })).json();
  const src = await (await get(`${BASE}/api/code-source?code=${builtin.codeId}`, { headers: { authorization: `Bearer ${TOKEN}` } })).text();
  const v2 = src.replace('case "c/name":', 'case "c/version":\n          return { version: 2 };\n        case "c/name":');
  const pub = await (await get(`${BASE}/api/code?app=conf`, { method: "POST", body: v2, headers: { authorization: `Bearer ${TOKEN}` } })).json();
  assert.notEqual(pub.codeId, builtin.codeId);
  await sleep(6000); // app registry cache
  assert.deepEqual(await a.op("c/version").then((r: any) => r.version), 2);
  assert.equal((await a.op("sql/get", { k: "a" })).v, "v1-data");
  assert.equal(await closed, 1012);
  // restore the stock conformance app for other tests
  await get(`${BASE}/api/code?app=conf&builtin=conformance`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } });
});

run("bindings-follow-move", async () => {
  // Pooled object A keeps calling pooled object B through env.BIND while B migrates to another
  // node: the bridge's cached placement goes stale, B's old node answers 410, and the call is
  // re-resolved and retried. Every call lands exactly once on B (2 pings per /do call).
  const callBind = async (name: string, op: string, qs = "") => {
    for (let attempt = 0; ; attempt++) {
      const res = await get(`${BASE}/pool/bind/${RUN}-${name}/${op}${qs}`);
      const text = await res.text();
      if (!text.startsWith("{") && attempt < 20) {
        await sleep(1500);
        continue;
      }
      const body = JSON.parse(text);
      assert.equal(body.error, undefined, `${op}: ${body.error}`);
      return { ...body, node: res.headers.get("x-pool-node") };
    }
  };
  const before = await callBind("bm-b", "count");
  assert.equal(before.count, 0);
  let calls = 0;
  let stop = false;
  const caller = (async () => {
    while (!stop) {
      await callBind("bm-a", "do", `?to=${RUN}-bm-b`);
      calls++;
    }
  })();
  await sleep(3000);
  const moved = await admin(`migrate?key=${encodeURIComponent(`bind/${RUN}-bm-b`)}`);
  assert.notEqual(moved.node, before.node, "B migrated to a different node");
  await sleep(4000);
  stop = true;
  await caller;
  const after = await callBind("bm-b", "count");
  assert.equal(after.node, moved.node, "B now answers from its new node");
  assert.ok(calls >= 4, `only ${calls} calls`);
  assert.equal(after.count, calls * 2, `${calls} calls → ${after.count} pings recorded`);
});

run("sandbox-isolation", async () => {
  // Two sandboxed apps on the pool: each runs in its own process/uid/namespaces; from inside one,
  // the other's data, the router's admin port, the internet and other tenants' checkpoints are
  // all out of reach.
  const mine = `${BASE}/pool/sapp/conf:${RUN}-iso`;
  const res = await get(`${mine}/sql/put?k=secret&v=conf-secret`);
  const node = res.headers.get("x-pool-node")!;
  assert.ok(res.ok);
  const probe = await (
    await get(`${BASE}/api/probe?node=${node}&app=evil`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } })
  ).text();
  console.log(probe);
  assert.match(probe, /id: uid=200\d\d/, "runs as its own uid");
  assert.match(probe, /ls \/data\/tenants: .*No such file/, "other tenants' data not visible");
  assert.match(probe, /other slot: .*No such file/, "other tenants' sockets not visible");
  assert.match(probe, /router admin: \s*$/m, "router admin unreachable");
  assert.match(probe, /internet: 000/, "no network");
  assert.match(probe, /Read-only file system/, "system read-only");
  assert.match(probe, /bridge other tenant: .* 403/, "bridge refuses other tenants' checkpoints");
  assert.match(probe, /bridge stats\/drain: 403/, "bridge refuses control endpoints");
});

run("sandbox-sleep-wake", async () => {
  // Regression: a filesystem snapshot restores the old /run (stale sockets, ready markers) and
  // tenant data owned by a previous slot's uid. Sandboxed apps must work after a wake.
  const chat = `${BASE}/pool/sapp/chat:${RUN}-ssw`;
  const ws1 = new WebSocket(`${chat.replace(/^http/, "ws")}/ws?name=before`, { perMessageDeflate: false });
  await new Promise((r, j) => (ws1.once("open", r), ws1.once("error", j)));
  ws1.send("written before sleep");
  await sleep(1500);
  ws1.close();
  const node = (await get(`${chat}/history`)).headers.get("x-pool-node")!;
  const slept = await admin(`sleep-node?node=${node}`);
  assert.equal(slept.slept, true, JSON.stringify(slept));
  const ws2 = new WebSocket(`${chat.replace(/^http/, "ws")}/ws?name=after`, { perMessageDeflate: false });
  const first = await new Promise<any>((r, j) => {
    ws2.once("message", (d) => r(JSON.parse(String(d))));
    ws2.once("error", j);
    ws2.once("unexpected-response", (_q, res) => j(new Error(`ws HTTP ${res.statusCode}`)));
  });
  assert.equal(first.type, "history");
  assert.deepEqual(first.messages.map((m: any) => m.text), ["written before sleep"]);
  ws2.close();
});

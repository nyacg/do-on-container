/**
 * WebSocket load generator for the demo classes (cursors, ticker), against either backend.
 *
 *   npx tsx bench/load.ts --backend pool --rooms 100 --per 10 --hz 5 --secs 30
 *
 * Every client joins /{backend}/cursors/{prefix}-{i % rooms}, sends cursor moves at --hz,
 * and pings once a second for RTT. Pool stats are sampled out-of-band from /api/status.
 * Prints one JSON line with the results (append to a file with --out).
 */
import WebSocket from "ws";
import { appendFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values: o } = parseArgs({
  options: {
    base: { type: "string", default: "https://do-pool.do-pool-lab.workers.dev" },
    backend: { type: "string", default: "pool" },
    cls: { type: "string", default: "cursors" },
    rooms: { type: "string", default: "10" },
    per: { type: "string", default: "10" },
    hz: { type: "string", default: "5" },
    secs: { type: "string", default: "20" },
    batch: { type: "string", default: "100" },
    prefix: { type: "string", default: `bench-${Date.now().toString(36)}` },
    label: { type: "string", default: "" },
    out: { type: "string" },
  },
});
const ROOMS = +o.rooms!, PER = +o.per!, HZ = +o.hz!, SECS = +o.secs!, N = ROOMS * PER;
const wsBase = o.base!.replace(/^http/, "ws");

const socks: WebSocket[] = [];
let opened = 0, errors = 0, closed1012 = 0, framesIn = 0, sent = 0;
const rtts: number[] = [];
const errorSamples = new Set<string>();

function connect(i: number): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => (done ? undefined : ((done = true), resolve()));
    const ws = new WebSocket(`${wsBase}/${o.backend}/${o.cls}/${o.prefix}-${i % ROOMS}`, { perMessageDeflate: false });
    ws.on("open", () => {
      opened++;
      socks.push(ws);
      finish();
    });
    ws.on("message", (d) => {
      framesIn++;
      const s = d.toString();
      if (s.startsWith('{"t":"p"')) rtts.push(performance.now() - JSON.parse(s).ts);
    });
    ws.on("close", (code) => code === 1012 && closed1012++);
    ws.on("unexpected-response", (_req, res) => {
      errors++;
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        errorSamples.add(`HTTP ${res.statusCode} ${body.slice(0, 100)}`);
        finish();
      });
    });
    ws.on("error", (e) => {
      errors++;
      errorSamples.add(e.message.slice(0, 120));
      finish();
    });
  });
}

const avg = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const pct = (a: number[], q: number) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return +s[Math.min(s.length - 1, Math.floor(s.length * q))].toFixed(1);
};

async function poolStats() {
  try {
    const s = (await (await fetch(`${o.base}/api/status`)).json()) as { nodes: { name: string; status: string; stats: any }[] };
    return s.nodes.filter((n) => n.status !== "stopped").map((n) => ({ node: n.name, ...n.stats }));
  } catch {
    return [];
  }
}

const t0 = Date.now();
for (let b = 0; b < N; b += +o.batch!) {
  await Promise.all(Array.from({ length: Math.min(+o.batch!, N - b) }, (_, j) => connect(b + j)));
}
const connectMs = Date.now() - t0;
console.error(`connected ${opened}/${N} in ${connectMs}ms (${errors} errors)`);

// Measurement phase.
framesIn = 0;
rtts.length = 0;
const samples: any[] = [];
const moveEvery = HZ > 0 ? 1000 / HZ : 0;
const mover = moveEvery
  ? setInterval(() => {
      for (const ws of socks) {
        if (ws.readyState !== 1) continue;
        ws.send(JSON.stringify({ t: "m", x: Math.random(), y: Math.random() }));
        sent++;
      }
    }, moveEvery)
  : undefined;
const pinger = setInterval(() => {
  for (let i = 0; i < Math.min(50, socks.length); i++) {
    const ws = socks[Math.floor(Math.random() * socks.length)];
    if (ws.readyState === 1) ws.send(JSON.stringify({ t: "p", ts: performance.now() }));
  }
}, 1000);
const sampler = o.backend === "pool" ? setInterval(async () => samples.push(await poolStats()), 5000) : undefined;
await new Promise((r) => setTimeout(r, SECS * 1000));
clearInterval(mover);
clearInterval(pinger);
clearInterval(sampler);
await new Promise((r) => setTimeout(r, 1000));

const nodesSeen = new Map<string, { cpu: number[]; conns: number[]; memMB: number[]; rssMB: number[] }>();
for (const snap of samples)
  for (const n of snap) {
    const e = nodesSeen.get(n.node) ?? { cpu: [], conns: [], memMB: [], rssMB: [] };
    e.cpu.push(n.cpuCores ?? 0);
    e.conns.push(n.conns ?? 0);
    e.memMB.push(Math.round((n.memUsedKb ?? 0) / 1024));
    e.rssMB.push(Math.round((n.workerdRssKb ?? 0) / 1024));
    nodesSeen.set(n.node, e);
  }
const result = {
  at: new Date().toISOString(),
  label: o.label,
  backend: o.backend,
  cls: o.cls,
  rooms: ROOMS,
  per: PER,
  hz: HZ,
  secs: SECS,
  opened,
  errors,
  errorSamples: [...errorSamples].slice(0, 3),
  connectMs,
  sentPerSec: Math.round(sent / SECS),
  framesInPerSec: Math.round(framesIn / SECS),
  rttP50: pct(rtts, 0.5),
  rttP90: pct(rtts, 0.9),
  rttP99: pct(rtts, 0.99),
  closed1012,
  nodes: Object.fromEntries(
    [...nodesSeen].map(([k, v]) => [k, { cpuMax: Math.max(...v.cpu), cpuAvgLastHalf: +avg(v.cpu.slice(Math.floor(v.cpu.length / 2))).toFixed(3), conns: Math.max(...v.conns), memMB: Math.max(...v.memMB), rssMB: Math.max(...v.rssMB) }]),
  ),
};
console.log(JSON.stringify(result));
if (o.out) appendFileSync(o.out, JSON.stringify(result) + "\n");
for (const ws of socks) ws.terminate();
process.exit(0);

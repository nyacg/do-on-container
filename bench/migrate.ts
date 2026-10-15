/**
 * Live migration correctness: keep writing to a pooled object while Placement moves it
 * between nodes, then check that every write the server acknowledged survived.
 *
 *   ADMIN_TOKEN=... npx tsx bench/migrate.ts [moves=3]
 *
 * A "write" is a stamp in a cursors room; the server acknowledges it by broadcasting it back.
 */
import WebSocket from "ws";

const base = process.env.BASE ?? "https://do-pool.do-pool-lab.workers.dev";
const token = process.env.ADMIN_TOKEN!;
const moves = Number(process.argv[2] ?? 3);
const room = `mig-${Date.now().toString(36)}`;
const key = `cursors/${room}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let acked = 0, sent = 0, reconnects = 0, gaps: number[] = [];
let ws: WebSocket | undefined;
let downSince = 0;

function connect() {
  const s = new WebSocket(`${base.replace(/^http/, "ws")}/pool/cursors/${room}`, { perMessageDeflate: false });
  s.on("open", () => {
    if (downSince) gaps.push(Date.now() - downSince);
    downSince = 0;
    ws = s;
  });
  s.on("message", (d) => {
    const m = JSON.parse(String(d));
    if (m.t === "s") acked++;
  });
  s.on("close", () => {
    if (ws === s) ws = undefined;
    if (!downSince) downSince = Date.now();
    reconnects++;
    setTimeout(connect, 100);
  });
  s.on("error", () => {});
  s.on("unexpected-response", () => s.emit("close"));
}

const node = async () => (await fetch(`${base}/pool/cursors/${room}/info`)).headers.get("x-pool-node");
connect();
await sleep(2000);
const path = [await node()];
const writer = setInterval(() => {
  if (ws?.readyState === 1) {
    ws.send(JSON.stringify({ t: "s", x: Math.random(), y: Math.random() }));
    sent++;
  }
}, 200);

for (let i = 0; i < moves; i++) {
  await sleep(6000);
  const r = await fetch(`${base}/api/migrate?key=${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  const text = await r.text();
  if (!r.ok) console.error(`migrate ${r.status}: ${text.slice(0, 300)}`);
  path.push(r.ok ? (JSON.parse(text) as { node: string }).node : `error ${r.status}`);
}
await sleep(6000);
clearInterval(writer);
await sleep(1500);
const infoRes = await fetch(`${base}/pool/cursors/${room}/info`);
const infoText = await infoRes.text();
if (!infoRes.ok) console.error(`info ${infoRes.status} ${infoRes.headers.get("x-pool-node")}: ${infoText.slice(0, 500)}`);
const info = (infoRes.ok ? JSON.parse(infoText) : { stamps: -1 }) as { stamps: number };
console.log(
  JSON.stringify({
    room,
    path,
    sent,
    acked,
    persisted: info.stamps,
    lostAcked: Math.max(0, Math.min(acked, 300) - info.stamps), // room keeps the newest 300
    reconnects: reconnects,
    reconnectGapsMs: gaps,
  }),
);
process.exit(0);

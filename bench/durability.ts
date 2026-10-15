/**
 * What happens to a pooled object's state when its node goes away?
 *
 *   npx tsx bench/durability.ts sigterm   # rollout / scale-down: supervisor drains first
 *   npx tsx bench/durability.ts sigkill   # host failure: no drain
 *
 * Writes stamps to a cursors room, takes the node down, measures how long until the room
 * answers again and how many stamps survived.
 */
import WebSocket from "ws";

const base = process.env.BASE ?? "https://do-pool.do-pool-lab.workers.dev";
const token = process.env.ADMIN_TOKEN!;
const mode = process.argv[2] === "sigkill" ? "sigkill" : "sigterm";
const room = `dur-${mode}-${Date.now().toString(36)}`;
const wsUrl = `${base.replace(/^http/, "ws")}/pool/cursors/${room}`;

function open(): Promise<{ ws: WebSocket; stamps: number }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false });
    ws.once("message", (d) => resolve({ ws, stamps: JSON.parse(String(d)).stamps.length }));
    ws.once("error", reject);
    ws.once("unexpected-response", (_q, r) => reject(new Error(`HTTP ${r.statusCode}`)));
  });
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function stamp(ws: WebSocket, n: number) {
  for (let i = 0; i < n; i++) ws.send(JSON.stringify({ t: "s", x: Math.random(), y: Math.random() }));
  await sleep(500);
}

const { ws } = await open();
const node = (await fetch(`${base}/pool/cursors/${room}/info`)).headers.get("x-pool-node");
console.error(`room ${room} on ${node}`);
await stamp(ws, 5);
console.error("5 stamps written; waiting 40s so a periodic flush covers them");
await sleep(40_000);
await stamp(ws, 5);
console.error("5 more stamps written (not yet flushed)");

let closeCode = 0;
ws.on("close", (c) => (closeCode = c));
const t0 = Date.now();
await fetch(`${base}/api/${mode === "sigkill" ? "kill-node" : "stop-node"}?node=${node}`, {
  method: "POST",
  headers: { authorization: `Bearer ${token}` },
});
console.error(`${mode} sent to ${node}`);

let result: { stamps: number } | undefined;
let attempts = 0;
while (!result && Date.now() - t0 < 180_000) {
  attempts++;
  try {
    const r = await open();
    result = r;
    r.ws.close();
  } catch {
    await sleep(500);
  }
}
const newNode = (await fetch(`${base}/pool/cursors/${room}/info`)).headers.get("x-pool-node");
console.log(
  JSON.stringify({
    mode,
    room,
    from: node,
    to: newNode,
    clientCloseCode: closeCode,
    unavailableMs: Date.now() - t0,
    attempts,
    stampsWritten: 10,
    stampsSurvived: result?.stamps ?? null,
  }),
);
process.exit(0);

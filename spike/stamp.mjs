import WebSocket from "ws";
const [url, n = 5] = process.argv.slice(2);
const ws = new WebSocket(url, { headers: { "x-do-class": "cursors", "x-do-name": "lobby" } });
ws.on("message", (d) => { const m = JSON.parse(d); if (m.t === "hello") console.log("hello: stamps=", m.stamps.length, "pooled=", m.pooled); });
ws.on("open", async () => {
  for (let i = 0; i < +n; i++) ws.send(JSON.stringify({ t: "s", x: Math.random(), y: Math.random() }));
  ws.send(JSON.stringify({ t: "p", ts: Date.now() }));
  setTimeout(() => { ws.close(); process.exit(0); }, 500);
});
ws.on("unexpected-response", (q, r) => { console.log("HTTP", r.statusCode); process.exit(1); });

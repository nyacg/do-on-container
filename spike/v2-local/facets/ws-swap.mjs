// Open a hibernatable socket on facet, swap code via /swap, observe what happens to the socket.
const base = process.argv[2] ?? "localhost:8783";
const ws = new WebSocket(`ws://${base}/t/r2/v1/ws`);
const events = [];
ws.onmessage = (e) => events.push(["msg", JSON.parse(e.data)]);
ws.onclose = (e) => events.push(["close", e.code, e.reason]);
ws.onerror = (e) => events.push(["error", e.message ?? ""]);
await new Promise((r) => (ws.onopen = r));
ws.send("before");
await new Promise((r) => setTimeout(r, 200));
const swap = await (await fetch(`http://${base}/swap/r2/v2`)).json();
console.log("swap ->", swap.version, "sockets seen by new facet:", swap.sockets);
await new Promise((r) => setTimeout(r, 300));
try { ws.send("after"); } catch (e) { events.push(["send-throw", String(e)]); }
await new Promise((r) => setTimeout(r, 500));
console.log(JSON.stringify(events, null, 1));
process.exit(0);

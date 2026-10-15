// usage: node bench/celld/smoke.mjs [baseUrl]   (default http://localhost:8090)
// Checks /r/:name/touch counts up and that ping/echo:/broadcast work over hibernatable WebSockets.
import WebSocket from "ws";
const base = process.argv[2] || "http://localhost:8090";
const room = "smoke" + Date.now();
const ns = [];
for (let i = 0; i < 3; i++) ns.push((await (await fetch(`${base}/r/${room}/touch`)).json()).n);
console.log("touch", ns);
const wsBase = base.replace(/^http/, "ws");
const a = new WebSocket(`${wsBase}/r/${room}/ws`), b = new WebSocket(`${wsBase}/r/${room}/ws`);
await Promise.all([a, b].map(w => new Promise((r, j) => { w.on("open", r); w.on("error", j); })));
const got = { a: [], b: [] };
a.on("message", d => got.a.push(d.toString()));
b.on("message", d => got.b.push(d.toString()));
a.send("ping"); a.send("echo:hello"); a.send("broadcast-from-a");
await new Promise(r => setTimeout(r, 500));
console.log("ws", JSON.stringify(got));
const ok = ns.join() === "1,2,3" && got.a.join() === "pong,echo:hello" && got.b.join() === "broadcast-from-a";
console.log(ok ? "OK" : "FAIL");
process.exit(ok ? 0 : 1);

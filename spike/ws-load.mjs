// usage: node ws-load.mjs <baseUrl> <rooms> <perRoom> <msgsPerSecPerClient> <seconds>
import WebSocket from "ws";
const [base = "ws://localhost:8080", rooms = 100, per = 10, rate = 0, secs = 10] = process.argv.slice(2);
const R = +rooms, P = +per, RATE = +rate, S = +secs;
const socks = []; let opened = 0, recv = 0, errors = 0; const rtts = [];
const t0 = Date.now();
const BATCH = +(process.env.BATCH || 200);
for (let b = 0; b < R * P; b += BATCH) await Promise.all(Array.from({ length: Math.min(BATCH, R * P - b) }, (_, j) => new Promise((res) => {
  let done = false; const res2 = () => { if (!done) { done = true; res(); } };
  const i = b + j;
  const ws = new WebSocket(`${base}/r/room${i % R}/ws${process.env.QS || ""}`, { perMessageDeflate: process.env.DEFLATE === "1" });
  ws.on("open", () => { opened++; socks.push(ws); res(); });
  ws.on("message", (d) => { recv++; const s = d.toString(); if (s.startsWith("echo:")) rtts.push(performance.now() - +s.slice(5)); });
  ws.on("unexpected-response", (req, res) => { let b = ""; res.on("data", c => b += c); res.on("end", () => { errors++; if (errors < 3) console.error("HTTP", res.statusCode, b.slice(0, 200)); res2(); }); });
  ws.on("error", (e) => { errors++; if (errors < 3) console.error(e.message); res(); });
})));
console.log(JSON.stringify({ opened, errors, connectMs: Date.now() - t0 }));
// rtt probes
for (let i = 0; i < Math.min(200, socks.length); i++) socks[i].send("echo:" + performance.now());
await new Promise(r => setTimeout(r, 1000));
rtts.sort((a, b) => a - b);
console.log(JSON.stringify({ idleRttP50: rtts[rtts.length >> 1]?.toFixed(2), idleRttP99: rtts[Math.floor(rtts.length * 0.99)]?.toFixed(2) }));
const samples = [];
let sampler;
if (process.env.STATS_URL) sampler = setInterval(async () => {
  try { const j = await (await fetch(process.env.STATS_URL + "?t=" + Date.now())).json(); const d = j.cpuCores !== undefined ? j : Object.entries(j).filter(([k]) => k.startsWith(process.env.STATS_KEY || "")).map(([, v]) => v).sort((a, b) => b.at - a.at)[0]; samples.push(d); } catch {}
}, 2000);
if (RATE > 0) {
  recv = 0; let sent = 0; rtts.length = 0;
  const iv = setInterval(() => {
    for (const ws of socks) { ws.send(JSON.stringify({ x: Math.random(), y: Math.random() })); sent++; }
    for (let i = 0; i < 20 && i < socks.length; i++) socks[(Math.random() * socks.length) | 0].send("echo:" + performance.now());
  }, 1000 / RATE);
  await new Promise(r => setTimeout(r, S * 1000)); clearInterval(iv);
  await new Promise(r => setTimeout(r, 500));
  rtts.sort((a, b) => a - b);
  console.log(JSON.stringify({ sentPerSec: Math.round(sent / S), recvPerSec: Math.round(recv / S), loadedRttP50: rtts[rtts.length >> 1]?.toFixed(1), loadedRttP99: rtts[Math.floor(rtts.length * 0.99)]?.toFixed(1) }));
}
if (sampler) {
  clearInterval(sampler);
  const c = samples.map(d => d.cpuCores);
  console.log(JSON.stringify({ containerCpuCores: c.map(x => +x.toFixed(2)), rssMB: samples.map(d => d.workerdRssKb >> 10) }));
}
if (process.env.HOLD) await new Promise(r => setTimeout(r, +process.env.HOLD * 1000));
for (const ws of socks) ws.close();
process.exit(0);

// node ws-test.mjs <url> [holdMs]  — opens 2 sockets, sends a message on each, prints replies,
// then (optionally) holds them idle for holdMs and sends again (hibernation check).
const [url, holdMs = "0"] = process.argv.slice(2);
const open = () => new Promise((res, rej) => { const ws = new WebSocket(url); ws.onopen = () => res(ws); ws.onerror = (e) => rej(new Error("ws error " + (e.message ?? ""))); });
const ask = (ws, m) => new Promise((res) => { ws.onmessage = (e) => res(JSON.parse(e.data)); ws.send(m); });
const a = await open(), b = await open();
console.log("a:", JSON.stringify(await ask(a, "hi-a")));
console.log("b:", JSON.stringify(await ask(b, "hi-b")));
if (+holdMs) {
  console.log(`holding ${holdMs}ms idle...`);
  await new Promise((r) => setTimeout(r, +holdMs));
  console.log("a after idle:", JSON.stringify(await ask(a, "again-a")));
}
a.close(1000, "bye"); b.close(1000, "bye");
setTimeout(() => process.exit(0), 300);

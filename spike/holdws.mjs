import WebSocket from "ws";
const ws = new WebSocket(process.argv[2], { perMessageDeflate: false });
ws.on("open", () => setInterval(() => ws.send(JSON.stringify({ t: "s", x: Math.random(), y: Math.random() })), 200));
ws.on("close", (c) => { console.log("closed", c); process.exit(0); });
setTimeout(() => process.exit(0), 20000);

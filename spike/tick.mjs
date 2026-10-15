import WebSocket from "ws";
const ws = new WebSocket(process.argv[2], { headers: { "x-do-class": "ticker", "x-do-name": "tk" } });
ws.on("message", (d) => console.log(String(d)));
setTimeout(() => process.exit(0), +process.argv[3] || 2500);

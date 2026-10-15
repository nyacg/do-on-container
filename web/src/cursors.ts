import { bar, params, wsOrigin, RttMeter, setConn } from "./common";

const { backend, room } = params();
bar(backend, room, "cursors.html");
const board = document.getElementById("board")!;
const cursors = new Map<number, HTMLElement>();
const rtt = new RttMeter();
let ws: WebSocket;
let me = 0;
let lastSend = 0;
let frames = 0;

function cursorEl(id: number, color: string) {
  let el = cursors.get(id);
  if (!el) {
    el = document.createElement("div");
    el.className = "cursor";
    el.innerHTML = `<svg width="18" height="18" viewBox="0 0 18 18"><path d="M1 1 L1 15 L5 11 L8 17 L10 16 L7 10 L13 10 Z" fill="${color}" stroke="white" stroke-width="1"/></svg>`;
    board.appendChild(el);
    cursors.set(id, el);
  }
  return el;
}

function place(el: HTMLElement, x: number, y: number) {
  el.style.transform = `translate(${x * board.clientWidth}px, ${y * board.clientHeight}px)`;
}

function stamp(x: number, y: number, color: string) {
  const s = document.createElement("div");
  s.className = "stamp";
  s.style.background = color;
  s.style.left = `${x * 100}%`;
  s.style.top = `${y * 100}%`;
  board.appendChild(s);
}

function connect() {
  ws = new WebSocket(`${wsOrigin()}/${backend}/cursors/${encodeURIComponent(room)}`);
  ws.onopen = () => setConn("connected");
  ws.onclose = (e) => {
    setConn(e.code === 1012 ? "node draining — reconnecting" : "reconnecting…");
    for (const el of cursors.values()) el.remove();
    cursors.clear();
    setTimeout(connect, e.code === 1012 ? 50 : 1000);
  };
  ws.onmessage = (e) => {
    frames++;
    const m = JSON.parse(e.data);
    if (m.t === "hello") {
      me = m.you.id;
      board.querySelectorAll(".stamp").forEach((s) => s.remove());
      for (const [x, y, color] of [...m.stamps].reverse()) stamp(x, y, color);
      for (const [id, x, y, color] of m.cursors) if (id !== me) place(cursorEl(id, color), x, y);
    } else if (m.t === "c") {
      for (const [id, x, y, color] of m.u) {
        if (id === me) continue;
        if (x === undefined) {
          cursors.get(id)?.remove();
          cursors.delete(id);
        } else place(cursorEl(id, color), x, y);
      }
      document.getElementById("count")!.textContent = `${cursors.size + 1} here`;
    } else if (m.t === "s") stamp(m.x, m.y, m.color);
    else if (m.t === "p") rtt.add(performance.now() - m.ts);
  };
}

board.addEventListener("pointermove", (e) => {
  const now = performance.now();
  if (now - lastSend < 33 || ws?.readyState !== 1) return;
  lastSend = now;
  const r = board.getBoundingClientRect();
  ws.send(JSON.stringify({ t: "m", x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }));
});
board.addEventListener("click", (e) => {
  const r = board.getBoundingClientRect();
  ws?.send(JSON.stringify({ t: "s", x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }));
});
setInterval(() => ws?.readyState === 1 && ws.send(JSON.stringify({ t: "p", ts: performance.now() })), 1000);
connect();

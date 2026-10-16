/** Bindings example: AI chat rooms (objects/ai-room.ts) and their lobby (objects/lobby.ts). */
import { mountNav } from "./nav";
import { wsOrigin } from "./common";

mountNav();

type Trace = { call: string; ms: number; note?: string }[];
type FileRef = { id: string; name: string; size: number; type: string };
type Msg = { id: number; kind: "text" | "ai" | "file" | "system"; name: string; text: string; at: number; file?: FileRef; trace?: Trace };

const q = new URLSearchParams(location.search);
const backend = q.get("backend") === "do" ? "do" : "pool";
const room = /^[a-z0-9-]{1,32}$/.test(q.get("room") ?? "") ? q.get("room")! : "general";
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const base = `/${backend}/room/${room}`;
const link = (b: string, r: string) => `/rooms.html?backend=${b}&room=${encodeURIComponent(r)}`;

const nameInput = $<HTMLInputElement>("name");
nameInput.value = localStorage.getItem("room-name") ?? `guest-${Math.random().toString(36).slice(2, 6)}`;
// The name is fixed per connection (it's the socket's attachment), so rejoin under the new one.
nameInput.onchange = () => (localStorage.setItem("room-name", nameInput.value), location.reload());

// ---------------------------------------------------------------- backend switch
$("backend").innerHTML = [
  ["do", "Real Durable Object", "Cloudflare's native bindings"],
  ["pool", "Pooled in a container", "the same bindings, through the bridge"],
]
  .map(([b, t, s]) => `<a class="${b === backend ? "on " : ""}${b}" href="${link(b, room)}"><b>${t}</b><span>${s}</span></a>`)
  .join("");
$("title").innerHTML = `# ${esc(room)} <span class="tag ${backend}">${backend === "do" ? "real DO" : "pooled"}</span>`;

// ---------------------------------------------------------------- reconnecting sockets
function socket(path: string, onMessage: (m: any) => void, onState: (s: string) => void) {
  let ws: WebSocket | undefined;
  let tries = 0;
  const open = () => {
    onState("connecting…");
    ws = new WebSocket(wsOrigin() + path);
    ws.onopen = () => ((tries = 0), onState("live"));
    ws.onmessage = (e) => onMessage(JSON.parse(e.data));
    // 1012 = the object moved to another node (or the node is sleeping): reconnect and get re-placed.
    ws.onclose = (e) => {
      onState(e.code === 1012 ? "object moved, reconnecting…" : "reconnecting…");
      setTimeout(open, Math.min(500 * 2 ** tries++, 8000));
    };
  };
  open();
  return { send: (data: unknown) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(data)) };
}

// ---------------------------------------------------------------- lobby
socket(
  `/${backend}/lobby/global/ws`,
  (m) => {
    if (m.type !== "rooms") return;
    const rooms: { name: string; users: number; last: string; at: number }[] = m.rooms;
    if (!rooms.some((r) => r.name === room)) rooms.unshift({ name: room, users: 0, last: "", at: Date.now() });
    $("rooms").innerHTML = rooms
      .map(
        (r) => `<li class="${r.name === room ? "on" : ""}"><a href="${link(backend, r.name)}"><b># ${esc(r.name)}</b>
          <span class="count">${r.users ? `${r.users} here` : ""}</span><span class="last">${esc(r.last || "quiet")}</span></a></li>`,
      )
      .join("");
  },
  (s) => ($("lobbystate").textContent = s),
);
$("newroom").onsubmit = (e) => {
  e.preventDefault();
  const r = $<HTMLInputElement>("roomname").value.trim().toLowerCase();
  if (/^[a-z0-9-]{1,32}$/.test(r)) location.href = link(backend, r);
};

// ---------------------------------------------------------------- chat
const log = $("log");
const seen = new Set<number>();

function traceHtml(trace?: Trace) {
  if (!trace?.length) return "";
  return `<div class="trace">${trace
    .map((t) => `<span class="call"><code>${esc(t.call)}</code> ${t.ms} ms${t.note ? ` · ${esc(t.note)}` : ""}</span>`)
    .join("")}</div>`;
}

function fileHtml(f: FileRef) {
  const url = `${base}/files/${f.id}`;
  const kb = `${Math.max(1, Math.round(f.size / 1024))} KB`;
  return /^image\/(png|jpeg|gif|webp)$/.test(f.type)
    ? `<a href="${url}" target="_blank"><img src="${url}" alt="${esc(f.name)}"></a><div class="note">${esc(f.name)} · ${kb} · stored in R2</div>`
    : `<a class="filelink" href="${url}">📄 ${esc(f.name)}</a> <span class="note">${kb} · stored in R2</span>`;
}

function add(m: Msg) {
  if (seen.has(m.id)) return;
  seen.add(m.id);
  const el = document.createElement("div");
  el.className = `m ${m.kind}${m.name === nameInput.value ? " me" : ""}`;
  const time = new Date(m.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  el.innerHTML =
    `<div class="who">${m.kind === "ai" ? "🤖 ai" : esc(m.name)} <time>${time}</time></div>` +
    `<div class="body">${m.kind === "file" && m.file ? fileHtml(m.file) : esc(m.text)}</div>` +
    traceHtml(m.trace);
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
  log.append(el);
  if (atBottom || m.name === nameInput.value) log.scrollTop = log.scrollHeight;
}

function system(text: string, trace?: Trace) {
  const el = document.createElement("div");
  el.className = "m system";
  el.innerHTML = `<div class="body">${esc(text)}</div>${traceHtml(trace)}`;
  log.append(el);
  log.scrollTop = log.scrollHeight;
}

let joined = false;
let chat: ReturnType<typeof socket>;
function connect() {
  chat = socket(
    `${base}/ws?name=${encodeURIComponent(nameInput.value)}`,
    (m) => {
      if (m.type === "history") {
        for (const x of m.messages as Msg[]) add(x); // after a reconnect, only what we missed (ids dedupe)
        joined = true;
        if (!log.children.length) system(`New room. Say hi, or ask "@ai what is a Durable Object?"`);
      } else if (m.type === "msg") {
        $("typing").textContent = "";
        add(m);
      } else if (m.type === "presence") {
        $("who").textContent = `${m.users.length} here: ${m.users.join(", ")}`;
      } else if (m.type === "typing") {
        $("typing").textContent = "ai is thinking…";
      } else if (m.type === "error") {
        system(m.text);
      }
    },
    (s) => joined && s !== "live" && system(s),
  );
}
connect();

$("send").onsubmit = (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>("msg");
  if (!input.value.trim()) return;
  chat.send({ text: input.value });
  input.value = "";
};

$<HTMLInputElement>("file").onchange = async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  (e.target as HTMLInputElement).value = "";
  if (!f) return;
  if (f.size > 1024 * 1024) return system("Files are limited to 1 MB in this demo.");
  const res = await fetch(`${base}/upload?name=${encodeURIComponent(nameInput.value)}&filename=${encodeURIComponent(f.name)}`, {
    method: "POST",
    headers: { "content-type": f.type || "application/octet-stream" },
    body: f,
  });
  const out = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (out.error) system(`Upload failed: ${out.error}`);
};

const TRIES = ["@ai what is a Durable Object, in one sentence?", "@ai tell me a joke about containers", "this is a darn good demo"];
$("tries").innerHTML = TRIES.map((t) => `<button type="button">${esc(t)}</button>`).join("");
$("tries").onclick = (e) => {
  const b = (e.target as HTMLElement).closest("button");
  if (b) chat.send({ text: b.textContent });
};

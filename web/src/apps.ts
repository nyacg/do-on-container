/** Playground for dynamically loaded apps (Durable Object facets) on three backends. */
import { mountNav } from "./nav";

type Preset = { label: string; method?: string; path: string; body?: string; ws?: boolean };
type AppInfo = { title: string; blurb: string; presets: Preset[] };

const APPS: Record<string, AppInfo> = {
  counter: {
    title: "Counter",
    blurb: "SQL, plus an alarm that resets it",
    presets: [
      { label: "GET /", path: "/" },
      { label: "POST /inc", method: "POST", path: "/inc" },
      { label: "Reset in 5 s (alarm)", method: "POST", path: "/reset-in?ms=5000" },
    ],
  },
  chat: {
    title: "Chat",
    blurb: "Hibernatable WebSockets, history in SQL",
    presets: [
      { label: "Join as you", path: "/ws?name=you", ws: true },
      { label: "GET /history", path: "/history" },
    ],
  },
  notes: {
    title: "Notes",
    blurb: "A REST API on the KV storage API",
    presets: [
      { label: "List", path: "/notes" },
      { label: "PUT hello", method: "PUT", path: "/notes/hello", body: "hi from a facet" },
      { label: "GET hello", path: "/notes/hello" },
      { label: "DELETE hello", method: "DELETE", path: "/notes/hello" },
    ],
  },
  reminders: {
    title: "Reminders",
    blurb: "Many scheduled jobs on one alarm",
    presets: [
      { label: "Watch (WebSocket)", path: "/ws", ws: true },
      { label: "Remind me in 5 s", method: "POST", path: "/remind?in=5000&text=stand+up" },
      { label: "List", path: "/" },
    ],
  },
};

const BACKENDS = [
  {
    id: "do/app",
    title: "Real Durable Object",
    where: "Cloudflare runs it: Dynamic Workers + a facet",
    color: "var(--orange)",
    soft: "var(--orange-soft)",
    rows: [
      ["State", "SQLite in Cloudflare's storage, replicated before a write is acknowledged"],
      ["Isolation", "Cloudflare's sandbox (isolates + defense in depth)"],
      ["Cost", "128 MB × wall-clock while awake"],
      ["Latency", "placed near its first caller"],
    ],
  },
  {
    id: "pool/app",
    title: "Pooled facet",
    where: "Bin-packed in a container, shared workerd process",
    color: "var(--blue)",
    soft: "var(--blue-soft)",
    rows: [
      ["State", "SQLite on the container's disk; checkpointed to R2 every 30 s"],
      ["Isolation", "V8 isolate per code version: fine for your own code"],
      ["Cost", "a sliver of a container (~0.2 KB–2 MB per object)"],
      ["Latency", "container in your region, next to its node DO"],
    ],
  },
  {
    id: "pool/sapp",
    title: "Sandboxed tenant",
    where: "Its own process inside the container",
    color: "var(--aqua)",
    soft: "var(--aqua-soft)",
    rows: [
      ["State", "same as pooled, in a per-app directory only it can see"],
      ["Isolation", "own uid + Linux namespaces, no network, in a microVM"],
      ["Cost", "~17 MB and ~25 ms to start per app per node"],
      ["Latency", "one extra local hop (unix socket)"],
    ],
  },
];

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const q = new URLSearchParams(location.search);
let app = q.get("app") ?? "counter";
let backend = q.get("backend") ?? "pool/app";
let ws: WebSocket | undefined;

const target = () => `/${backend}/${app}:demo`;

function render() {
  $("apps").innerHTML = Object.entries(APPS)
    .map(([id, a]) => `<button class="apptab ${id === app ? "on" : ""}" data-app="${id}"><b>${a.title}</b><span>${a.blurb}</span></button>`)
    .join("");
  $("backends").innerHTML = BACKENDS.map(
    (b) => `<button class="backend ${b.id === backend ? "on" : ""}" data-backend="${b.id}" style="--c:${b.color};--soft:${b.soft}">
      <h4>${b.title}</h4><p class="where">${b.where}</p>
      <dl>${b.rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl></button>`,
  ).join("");
  $("presets").innerHTML = "";
  for (const p of APPS[app].presets) {
    const btn = document.createElement("button");
    btn.textContent = p.label;
    btn.onclick = () => (p.ws ? openSocket(p.path) : send(p.method ?? "GET", p.path, p.body));
    $("presets").appendChild(btn);
  }
  $("target").textContent = target();
  $<HTMLInputElement>("wspath").value = APPS[app].presets.find((p) => p.ws)?.path ?? "/ws";
  history.replaceState(null, "", `?app=${app}&backend=${backend}`);
  document.querySelectorAll<HTMLButtonElement>(".apptab").forEach((b) => (b.onclick = () => switchTo(b.dataset.app!, backend)));
  document.querySelectorAll<HTMLButtonElement>(".backend").forEach((b) => (b.onclick = () => switchTo(app, b.dataset.backend!)));
}

async function switchTo(nextApp: string, nextBackend: string) {
  const appChanged = nextApp !== app;
  app = nextApp;
  backend = nextBackend;
  ws?.close();
  render();
  if (appChanged) await loadSource();
}

async function loadSource() {
  const res = await fetch(`/api/apps/${app}/source`);
  $<HTMLTextAreaElement>("src").value = await res.text();
  $("codeid").textContent = `version ${res.headers.get("x-code-id") ?? "?"}`;
}

function chip(text: string, cls = "") {
  return `<span class="tag ${cls}">${text}</span>`;
}

async function send(method: string, path: string, body?: string) {
  $<HTMLSelectElement>("method").value = method;
  $<HTMLInputElement>("path").value = path;
  $<HTMLInputElement>("body").value = body ?? "";
  $("meta").innerHTML = chip("…");
  const t0 = performance.now();
  const res = await fetch(target() + path, { method, body: method === "GET" || method === "DELETE" ? undefined : body ?? "" });
  const text = await res.text();
  const ms = performance.now() - t0;
  const node = res.headers.get("x-pool-node");
  let pretty = text;
  try {
    pretty = JSON.stringify(JSON.parse(text), null, 2);
  } catch {}
  $("meta").innerHTML =
    chip(`${res.status}`, res.ok ? "ok" : "err") +
    chip(`${ms.toFixed(0)} ms`) +
    chip(node ? `node ${node}` : backend === "do/app" ? "Cloudflare DO" : "pool") +
    chip(`${method} ${path}`);
  $("res").textContent = pretty;
}

function log(text: string, cls: "in" | "outm" | "sys") {
  const el = document.createElement("div");
  el.className = cls;
  el.textContent = `${new Date().toLocaleTimeString()}  ${text}`;
  $("wslog").prepend(el);
}

function setWs(state: string, cls = "") {
  $("wsstate").textContent = state;
  $("wsstate").className = `tag ${cls}`;
  $<HTMLButtonElement>("wssend").disabled = state !== "open";
}

function openSocket(path: string) {
  ws?.close();
  $<HTMLInputElement>("wspath").value = path;
  const s = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${target()}${path}`);
  ws = s;
  setWs("connecting…", "warn");
  s.onopen = () => (setWs("open", "sbx"), log("connected", "sys"));
  s.onmessage = (e) => log(`← ${e.data}`, "in");
  s.onerror = () => log("error", "sys");
  s.onclose = (e) => {
    if (ws !== s) return;
    setWs("closed");
    log(`closed ${e.code}${e.code === 1012 ? ": object moved or code updated, reconnecting" : ""}`, "sys");
    if (e.code === 1012) setTimeout(() => openSocket(path), 300);
  };
}

$("req").onsubmit = (e) => (e.preventDefault(), send($<HTMLSelectElement>("method").value, $<HTMLInputElement>("path").value, $<HTMLInputElement>("body").value));
$("wsform").onsubmit = (e) => (e.preventDefault(), openSocket($<HTMLInputElement>("wspath").value));
$("wssendform").onsubmit = (e) => {
  e.preventDefault();
  const m = $<HTMLInputElement>("wsmsg").value;
  if (!m || ws?.readyState !== 1) return;
  ws.send(m);
  log(`→ ${m}`, "outm");
  $<HTMLInputElement>("wsmsg").value = "";
};
$("pubform").onsubmit = async (e) => {
  e.preventDefault();
  const res = await fetch(`/api/code?app=${app}`, {
    method: "POST",
    headers: { authorization: `Bearer ${$<HTMLInputElement>("token").value}` },
    body: $<HTMLTextAreaElement>("src").value,
  });
  const text = await res.text();
  $("pubres").textContent = res.ok ? `Published ${JSON.parse(text).codeId}. It goes live on the next request (≤5 s app-registry cache).` : `${res.status}: ${text}`;
  if (res.ok) $("codeid").textContent = `version ${JSON.parse(text).codeId}`;
};

mountNav();
render();
loadSource();

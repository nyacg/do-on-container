/** Playground for dynamically loaded apps (Durable Object facets). */
type Preset = { label: string; method?: string; path: string; body?: string; ws?: boolean };

const PRESETS: Record<string, Preset[]> = {
  counter: [
    { label: "GET /", path: "/" },
    { label: "POST /inc", method: "POST", path: "/inc" },
    { label: "reset in 5 s (alarm)", method: "POST", path: "/reset-in?ms=5000" },
  ],
  notes: [
    { label: "list", path: "/notes" },
    { label: "PUT hello", method: "PUT", path: "/notes/hello", body: "hi from the pool" },
    { label: "GET hello", path: "/notes/hello" },
    { label: "DELETE hello", method: "DELETE", path: "/notes/hello" },
  ],
  chat: [
    { label: "connect as you", path: "/ws?name=you", ws: true },
    { label: "history", path: "/history" },
  ],
  reminders: [
    { label: "remind in 5 s", method: "POST", path: "/remind?in=5000&text=stand+up" },
    { label: "list", path: "/" },
    { label: "watch (ws)", path: "/ws", ws: true },
  ],
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const q = new URLSearchParams(location.search);
let ws: WebSocket | undefined;

function base() {
  const app = $<HTMLSelectElement>("app").value;
  const name = encodeURIComponent($<HTMLInputElement>("obj").value || "demo");
  return `/${$<HTMLSelectElement>("backend").value}/${app}:${name}`;
}

async function loadApps() {
  const apps = (await (await fetch("/api/apps")).json()) as { appId: string; codeId: string }[];
  const ids = apps.map((a) => a.appId).filter((id) => id !== "conf");
  const order = ["counter", "chat", "notes", "reminders"];
  ids.sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
  $<HTMLSelectElement>("app").innerHTML = ids.map((id) => `<option>${id}</option>`).join("");
  if (q.get("app") && ids.includes(q.get("app")!)) $<HTMLSelectElement>("app").value = q.get("app")!;
  if (q.get("backend")) $<HTMLSelectElement>("backend").value = q.get("backend")!;
  await selectApp();
}

async function selectApp() {
  const app = $<HTMLSelectElement>("app").value;
  const res = await fetch(`/api/apps/${app}/source`);
  $<HTMLTextAreaElement>("src").value = await res.text();
  $("codeid").textContent = `version ${res.headers.get("x-code-id") ?? "?"}`;
  $("presets").innerHTML = "";
  for (const p of PRESETS[app] ?? [{ label: "GET /", path: "/" }]) {
    const b = document.createElement("button");
    b.textContent = p.label;
    b.onclick = () => (p.ws ? openSocket(p.path) : send(p.method ?? "GET", p.path, p.body));
    $("presets").appendChild(b);
  }
  updateTarget();
}

function updateTarget() {
  $("target").textContent = `→ ${base()}`;
  history.replaceState(null, "", `?app=${$<HTMLSelectElement>("app").value}&backend=${$<HTMLSelectElement>("backend").value}`);
}

async function send(method: string, path: string, body?: string) {
  $<HTMLSelectElement>("method").value = method;
  $<HTMLInputElement>("path").value = path;
  $<HTMLInputElement>("body").value = body ?? "";
  const t0 = performance.now();
  const res = await fetch(base() + path, { method, body: method === "GET" || method === "DELETE" ? undefined : body ?? "" });
  const text = await res.text();
  const node = res.headers.get("x-pool-node");
  let pretty = text;
  try {
    pretty = JSON.stringify(JSON.parse(text), null, 2);
  } catch {}
  $("res").textContent = `${method} ${path} → ${res.status} · ${(performance.now() - t0).toFixed(0)} ms${node ? ` · ${node}` : ""}\n\n${pretty}`;
}

function log(line: string) {
  const el = $("wslog");
  el.textContent = `${new Date().toLocaleTimeString()} ${line}\n` + el.textContent;
}

function openSocket(path: string) {
  ws?.close();
  $<HTMLInputElement>("wspath").value = path;
  const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${base()}${path}`;
  ws = new WebSocket(url);
  ws.onopen = () => (log("open"), ($<HTMLButtonElement>("wssend").disabled = false));
  ws.onmessage = (e) => log(`← ${e.data}`);
  ws.onclose = (e) => {
    log(`closed ${e.code}${e.code === 1012 ? " (new code or object moved) — reconnecting" : ""}`);
    $<HTMLButtonElement>("wssend").disabled = true;
    if (e.code === 1012) setTimeout(() => openSocket(path), 300);
  };
}

$("app").onchange = selectApp;
$("backend").onchange = () => (ws?.close(), updateTarget());
$("obj").oninput = updateTarget;
$("req").onsubmit = (e) => (e.preventDefault(), send($<HTMLSelectElement>("method").value, $<HTMLInputElement>("path").value, $<HTMLInputElement>("body").value));
$("wsform").onsubmit = (e) => (e.preventDefault(), openSocket($<HTMLInputElement>("wspath").value));
$("wssend").onclick = () => {
  ws?.send($<HTMLInputElement>("wsmsg").value);
  log(`→ ${$<HTMLInputElement>("wsmsg").value}`);
  $<HTMLInputElement>("wsmsg").value = "";
};
$("publish").onclick = async () => {
  const app = $<HTMLSelectElement>("app").value;
  const res = await fetch(`/api/code?app=${app}`, {
    method: "POST",
    headers: { authorization: `Bearer ${$<HTMLInputElement>("token").value}` },
    body: $<HTMLTextAreaElement>("src").value,
  });
  const text = await res.text();
  $("pubres").textContent = res.ok ? `published ${JSON.parse(text).codeId} — live on the next request (~5 s cache)` : `${res.status} ${text}`;
  if (res.ok) $("codeid").textContent = `version ${JSON.parse(text).codeId}`;
};
loadApps();

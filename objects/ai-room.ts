import type { Lobby } from "./lobby";
import { PortableDurableObject, type PoolEnv } from "./portable";

/**
 * Example (bindings): a chat room with an AI in it. Written as an ordinary Durable Object; in
 * the pool every `this.env.*` call below goes through the bridge, on Cloudflare they're native.
 *
 *   MODERATOR  another Worker's named entrypoint (JS RPC): cleans up every message
 *   AI         Workers AI: answers messages that start with "@ai" (or every message, when
 *              you're alone in the room)
 *   KV         caches AI answers per room and question
 *   FILES      R2: attachments
 *   LOBBY      another Durable Object: occupancy + last message, and the global AI budget
 *
 * Each message carries a `trace` of the binding calls it took and how long each one was, which
 * the page shows under the message (so the bridge's cost is visible, not hidden).
 *
 *   GET /ws?name=       join                     GET /history        last 50 messages
 *   POST /upload?name=&filename=   attach a file (≤ 1 MB)    GET /files/<id>    download it
 */
const MODEL = "@cf/meta/llama-3.2-3b-instruct";
const PROMPT_VERSION = 2; // part of the KV cache key
const SYSTEM_PROMPT = `You are a friendly participant in a group chat on the do-pool demo site. do-pool runs
Cloudflare Durable Objects (stateful serverless objects, each with its own SQLite database, addressed by name)
packed by the thousand into workerd inside Cloudflare Containers, which is much cheaper for objects that stay
awake. This chat room is itself a Durable Object. When people say "Durable Object", "DO", "Worker" or
"container", they mean Cloudflare's. Reply in at most 50 words, plain text, no markdown.`;
const MAX_FILE = 1024 * 1024;
const MAX_FILES = 30;
const SAFE_INLINE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export interface RoomEnv extends PoolEnv {
  AI: Ai;
  KV: KVNamespace;
  FILES: R2Bucket;
  MODERATOR: Fetcher & { moderate(text: string): Promise<{ text: string; flagged: boolean }> };
  LOBBY: DurableObjectNamespace<Lobby>;
}

type Trace = { call: string; ms: number; note?: string }[];
type FileRef = { id: string; name: string; size: number; type: string };
interface Msg {
  id: number;
  kind: "text" | "ai" | "file" | "system";
  name: string;
  text: string;
  at: number;
  file?: FileRef;
  trace?: Trace;
}

export class AiRoom extends PortableDurableObject<RoomEnv> {
  static slug = "room";
  private aiBusy = false;
  private reports = 0;

  protected onStart() {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, name TEXT, text TEXT, file TEXT, trace TEXT, at INTEGER)",
    );
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean);
    const at = parts.indexOf("room");
    const route = parts.slice(at >= 0 ? at + 2 : 0); // after /<backend>/room/<name>
    const name = (url.searchParams.get("name") ?? "anon").replace(/[^\w .-]/g, "").slice(0, 24) || "anon";

    if (route[0] === "ws" && req.headers.get("upgrade") === "websocket") {
      const { 0: client, 1: server } = new WebSocketPair();
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ name });
      server.send(JSON.stringify({ type: "history", messages: this.history(), pooled: this.pooled }));
      const trace: Trace = [];
      await this.reportToLobby(trace);
      this.broadcast({ type: "presence", users: this.users(), trace });
      return new Response(null, { status: 101, webSocket: client });
    }
    if (route[0] === "history") return Response.json({ messages: this.history(), pooled: this.pooled });
    if (route[0] === "upload" && req.method === "POST") return this.upload(req, name, url.searchParams.get("filename") ?? "file");
    if (route[0] === "files" && route[1]) return this.download(route[1]);
    return new Response("usage: /ws?name= · /history · POST /upload?name=&filename= · /files/<id>", { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    if (typeof raw !== "string") return;
    let text = "";
    try {
      text = String(JSON.parse(raw).text ?? "");
    } catch {
      return;
    }
    if (!text.trim()) return;
    const { name } = ws.deserializeAttachment() as { name: string };
    const trace: Trace = [];
    const clean = await timed(trace, "MODERATOR.moderate()", () => this.env.MODERATOR.moderate(text), (r) => (r.flagged ? "masked" : "ok"));
    this.post({ kind: "text", name, text: clean.text, trace });
    // "@ai …" asks the AI; if nobody else is here, it answers everything.
    const mentioned = /^@ai\b/i.test(clean.text);
    if (mentioned || this.users().length <= 1) await this.askAi(ws, clean.text.replace(/^@ai\b[:,]?\s*/i, ""));
  }

  async webSocketClose(ws: WebSocket, code: number) {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code);
    } catch {}
    const trace: Trace = [];
    await this.reportToLobby(trace, undefined, ws);
    this.broadcast({ type: "presence", users: this.users(ws), trace });
  }

  // ---------------------------------------------------------------- AI

  private async askAi(ws: WebSocket, question: string) {
    if (!question.trim()) return;
    if (this.aiBusy) return ws.send(JSON.stringify({ type: "error", text: "The AI is still answering the last question." }));
    this.aiBusy = true;
    this.broadcast({ type: "typing", name: "ai" });
    const trace: Trace = [];
    try {
      // Per room: answers depend on the room's conversation, and a new room should get a fresh one.
      const key = `ai/${MODEL}/${PROMPT_VERSION}/${await sha256(`${this.doName}\n${question.toLowerCase().trim()}`)}`;
      let answer = await timed(trace, "KV.get()", () => this.env.KV.get(key), (v) => (v ? "hit" : "miss"));
      if (!answer) {
        const budget = await timed(trace, "LOBBY.takeAiBudget()", () => this.env.LOBBY.getByName(this.lobbyName()).takeAiBudget(), (b) => `${b.used}/${b.limit} today`);
        if (!budget.ok) {
          answer = "I've hit today's demo budget for AI replies. Try again tomorrow!";
        } else {
          const context = this.history(8).filter((m) => m.kind === "text" || m.kind === "ai");
          const out = (await timed(trace, "AI.run()", () =>
            this.env.AI.run(MODEL, {
              messages: [
                { role: "system", content: SYSTEM_PROMPT },
                ...context.map((m) => ({ role: m.kind === "ai" ? "assistant" : "user", content: m.kind === "ai" ? m.text : `${m.name}: ${m.text}` })),
                { role: "user", content: question },
              ],
              max_tokens: 120,
            }),
          )) as { response?: string };
          answer = (out.response ?? "").trim() || "…";
          const a = answer;
          await timed(trace, "KV.put()", () => this.env.KV.put(key, a, { expirationTtl: 3600 }));
        }
      }
      this.post({ kind: "ai", name: "ai", text: answer, trace });
    } catch (e) {
      this.post({ kind: "system", name: "system", text: `AI call failed: ${(e as Error).message}`, trace });
    } finally {
      this.aiBusy = false;
    }
  }

  // ---------------------------------------------------------------- files (R2)

  private async upload(req: Request, name: string, filename: string): Promise<Response> {
    const bytes = await req.arrayBuffer();
    if (bytes.byteLength > MAX_FILE) return Response.json({ error: "files are limited to 1 MB in this demo" }, { status: 413 });
    const files = this.ctx.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE kind = 'file'").one().n;
    if (files >= MAX_FILES) return Response.json({ error: `this room already has ${MAX_FILES} files` }, { status: 409 });
    const type = (req.headers.get("content-type") ?? "application/octet-stream").split(";")[0];
    const id = crypto.randomUUID();
    const file: FileRef = { id, name: filename.replace(/[^\w .()-]/g, "_").slice(0, 80), size: bytes.byteLength, type };
    const trace: Trace = [];
    await timed(trace, "FILES.put()", () =>
      this.env.FILES.put(this.fileKey(id), bytes, { httpMetadata: { contentType: type }, customMetadata: { name: file.name, by: name } }),
    );
    const msg = this.post({ kind: "file", name, text: file.name, file, trace });
    return Response.json(msg);
  }

  private async download(id: string): Promise<Response> {
    if (!/^[0-9a-f-]{36}$/.test(id)) return new Response("bad id", { status: 400 });
    const obj = await this.env.FILES.get(this.fileKey(id));
    if (!obj) return new Response("not found", { status: 404 });
    const type = obj.httpMetadata?.contentType ?? "";
    // User uploads on a shared origin: only plain images render inline; everything else downloads.
    const headers = new Headers({ "x-content-type-options": "nosniff", "cache-control": "private, max-age=3600" });
    if (SAFE_INLINE.has(type)) headers.set("content-type", type);
    else {
      headers.set("content-type", "application/octet-stream");
      headers.set("content-disposition", `attachment; filename="${obj.customMetadata?.name ?? id}"`);
    }
    return new Response(obj.body, { headers });
  }

  /** Test rooms (`t-…`) get their own lobby, so the public room list stays clean. */
  private lobbyName() {
    return this.doName.startsWith("t-") ? "tests" : "global";
  }

  private fileKey(id: string) {
    return `rooms/${encodeURIComponent(this.doName)}/${id}`;
  }

  // ---------------------------------------------------------------- plumbing

  private post(m: Omit<Msg, "id" | "at">): Msg {
    const at = Date.now();
    const id = this.ctx.storage.sql
      .exec<{ id: number }>(
        "INSERT INTO messages (kind, name, text, file, trace, at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
        m.kind, m.name, m.text, m.file ? JSON.stringify(m.file) : null, m.trace ? JSON.stringify(m.trace) : null, at,
      )
      .one().id;
    this.ctx.storage.sql.exec("DELETE FROM messages WHERE id <= ? AND kind != 'file'", id - 200);
    const msg: Msg = { ...m, id, at };
    this.broadcast({ type: "msg", ...msg });
    if (m.kind === "text" || m.kind === "ai" || m.kind === "file") {
      const t: Trace = [];
      // Not awaited by the sender's message path: the lobby is told in the background.
      this.ctx.waitUntil(this.reportToLobby(t, `${m.name}: ${m.text}`.slice(0, 80)).catch(() => {}));
    }
    return msg;
  }

  private history(limit = 50): Msg[] {
    return this.ctx.storage.sql
      .exec<{ id: number; kind: Msg["kind"]; name: string; text: string; file: string | null; trace: string | null; at: number }>(
        "SELECT * FROM (SELECT * FROM messages ORDER BY id DESC LIMIT ?) ORDER BY id",
        limit,
      )
      .toArray()
      .map((r) => ({ ...r, file: r.file ? JSON.parse(r.file) : undefined, trace: r.trace ? JSON.parse(r.trace) : undefined }));
  }

  private users(except?: WebSocket) {
    // A socket that's closing (or whose close handler hasn't run yet) is still listed: skip it.
    return this.ctx
      .getWebSockets()
      .filter((ws) => ws !== except && ws.readyState === WebSocket.OPEN)
      .map((ws) => (ws.deserializeAttachment() as { name: string } | null)?.name ?? "anon");
  }

  private broadcast(frame: unknown) {
    const s = JSON.stringify(frame);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(s);
      } catch {}
    }
  }

  /** DO → DO: tell the lobby how many people are here and what was said last. */
  private async reportToLobby(trace: Trace, last?: string, leaving?: WebSocket) {
    const users = this.users(leaving).length;
    const seq = Date.now() * 1000 + (this.reports++ % 1000);
    await timed(trace, "LOBBY.update()", () => this.env.LOBBY.getByName(this.lobbyName()).update(this.doName, users, last, seq)).catch(() => {});
  }
}

async function timed<T>(trace: Trace, call: string, f: () => Promise<T>, note?: (v: T) => string): Promise<T> {
  const t0 = Date.now();
  const v = await f();
  trace.push({ call, ms: Date.now() - t0, ...(note ? { note: note(v) } : {}) });
  return v;
}

async function sha256(s: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

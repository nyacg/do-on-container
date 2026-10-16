/**
 * Wire format for remote bindings (pooled object ⇄ bridge ⇄ real binding). JSON plus tagged
 * values for what JSON can't carry. Shared by the container (client + pooled RPC) and the
 * control Worker (server).
 *
 *   {$u8}  Uint8Array / other views     {$ab} ArrayBuffer      {$date} Date
 *   {$undef}  undefined (keeps argument positions)               {$err} Error
 *   {$req} Request    {$res} Response   {$r2} R2 object (+ body bytes)
 *   {$doid} DurableObjectId made by idFromName() on the client
 */
export type Step = { call: string; args: unknown[] } | { get: string };

function b64(u8: Uint8Array) {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function unb64(s: string) {
  const bin = atob(s);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}
const headersOf = (h: Headers) => [...h.entries()];
const isR2Object = (v: any) => v && typeof v === "object" && typeof v.key === "string" && "etag" in v && "uploaded" in v;

/** Values → JSON-safe (async: Request/Response/stream bodies are read). */
export async function encode(v: unknown): Promise<unknown> {
  if (v === undefined) return { $undef: true };
  if (v === null || typeof v !== "object") return v;
  if (v instanceof Uint8Array) return { $u8: b64(v) };
  if (ArrayBuffer.isView(v)) return { $u8: b64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) };
  if (v instanceof ArrayBuffer) return { $ab: b64(new Uint8Array(v)) };
  if (v instanceof Date) return { $date: v.toISOString() };
  if (v instanceof Error) return { $err: { name: v.name, message: v.message } };
  if (v instanceof Request) {
    const body = v.body ? b64(new Uint8Array(await v.arrayBuffer())) : null;
    return { $req: { url: v.url, method: v.method, headers: headersOf(v.headers), body } };
  }
  if (v instanceof Response) {
    const body = v.body ? b64(new Uint8Array(await v.arrayBuffer())) : null;
    return { $res: { status: v.status, statusText: v.statusText, headers: headersOf(v.headers), body } };
  }
  if (v instanceof ReadableStream) return { $u8: b64(new Uint8Array(await new Response(v).arrayBuffer())) };
  if (isR2Object(v)) {
    const o = v as R2Object & Partial<R2ObjectBody>;
    const meta = {
      key: o.key, version: o.version, size: o.size, etag: o.etag, httpEtag: o.httpEtag,
      uploaded: o.uploaded, httpMetadata: o.httpMetadata, customMetadata: o.customMetadata, storageClass: o.storageClass,
    };
    const body = typeof o.arrayBuffer === "function" ? b64(new Uint8Array(await o.arrayBuffer())) : null;
    // Field by field: `meta` itself looks like an R2 object, so encode(meta) would recurse.
    const fields: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(meta)) fields[k] = await encode(x);
    return { $r2: { meta: fields, body } };
  }
  if ((v as any).$doid) return v;
  if (Array.isArray(v)) return Promise.all(v.map(encode));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) out[k] = await encode(x);
  return out;
}

/** JSON-safe → values. R2 objects come back with the usual body methods. */
export function decode(v: any): any {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(decode);
  if (v.$undef) return undefined;
  if (typeof v.$u8 === "string") return unb64(v.$u8);
  if (typeof v.$ab === "string") return unb64(v.$ab).buffer;
  if (typeof v.$date === "string") return new Date(v.$date);
  if (v.$err) return Object.assign(new Error(v.$err.message), { name: v.$err.name });
  if (v.$req) {
    const r = v.$req;
    return new Request(r.url, { method: r.method, headers: r.headers, body: r.body === null ? null : unb64(r.body) });
  }
  if (v.$res) {
    const r = v.$res;
    return new Response(r.body === null ? null : unb64(r.body), { status: r.status, statusText: r.statusText, headers: r.headers });
  }
  if (v.$r2) {
    const meta = decode(v.$r2.meta);
    if (v.$r2.body === null) return meta;
    const bytes = unb64(v.$r2.body);
    return {
      ...meta,
      get body() {
        return new Response(bytes).body;
      },
      bodyUsed: false,
      arrayBuffer: async () => bytes.buffer,
      bytes: async () => bytes,
      text: async () => new TextDecoder().decode(bytes),
      json: async () => JSON.parse(new TextDecoder().decode(bytes)),
      blob: async () => new Blob([bytes]),
      writeHttpMetadata: (h: Headers) => {
        const m = meta.httpMetadata ?? {};
        if (m.contentType) h.set("content-type", m.contentType);
        if (m.contentLanguage) h.set("content-language", m.contentLanguage);
        if (m.cacheControl) h.set("cache-control", m.cacheControl);
      },
    };
  }
  if (v.$doid) return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) out[k] = decode(x);
  return out;
}

/** Apply a recorded call chain to a target (pipelining: only the final value is awaited). */
export async function applyChain(target: any, chain: Step[], resolveId: (doid: { name: string }) => unknown) {
  let cur = target;
  for (const step of chain) {
    if ("get" in step) {
      cur = cur[step.get];
      continue;
    }
    const args = (decode(step.args) as unknown[]).map((a: any) => (a && a.$doid ? resolveId(a.$doid) : a));
    const fn = cur[step.call];
    if (typeof fn !== "function") throw new TypeError(`${step.call} is not a function`);
    cur = Reflect.apply(fn, cur, args); // not fn.apply: on an RPC stub that is a remote method "apply"
  }
  return await cur;
}

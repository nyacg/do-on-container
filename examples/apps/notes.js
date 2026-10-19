// Notes: a tiny REST API on the synchronous KV storage API.
//   GET    /notes        → { notes: [{ id, text, at }] }
//   PUT    /notes/<id>   body = text
//   GET    /notes/<id>
//   DELETE /notes/<id>
import { DurableObject } from "cloudflare:workers";

export class App extends DurableObject {
  async fetch(req) {
    const [, collection, id] = new URL(req.url).pathname.split("/");
    if (collection !== "notes") return new Response("try /notes", { status: 404 });
    const kv = this.ctx.storage.kv;
    if (!id) return Response.json({ notes: [...kv.list({ prefix: "note:" })].map(([, v]) => v) });
    const key = `note:${id}`;
    switch (req.method) {
      case "PUT":
        kv.put(key, { id, text: await req.text(), at: Date.now() });
        return Response.json(kv.get(key));
      case "DELETE":
        return Response.json({ deleted: kv.delete(key) });
      default:
        return kv.get(key) ? Response.json(kv.get(key)) : new Response("not found", { status: 404 });
    }
  }
}

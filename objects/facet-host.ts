import { WorkerEntrypoint } from "cloudflare:workers";
import { PortableDurableObject, type PoolEnv } from "./portable";
import { bridgeFetch } from "./ckpt-store";
import { FACET_SHIM } from "./generated/facet-shim";
import type { Snapshot } from "./storage-dump";

/**
 * Hosts tenant code as a Durable Object facet: the app's module (stored in R2 under
 * `code/<codeId>.js`) is loaded with the Worker Loader and runs as facet "app", with its own
 * SQLite database that the host can't read and the app can't escape.
 *
 * Same class on both backends (real DO with Dynamic Workers on Cloudflare, or pooled in
 * workerd). Facets can't own alarms on either, so the root holds the facet's alarm and its
 * alarm() calls the facet. Pooled, the root also checkpoints the facet's database (via the
 * shim) and closes its sockets on moves.
 *
 * The request carries `x-app-code: <codeId>`; a different id than the running one hot-swaps
 * the code (sockets closed with 1012, data kept).
 */
export interface FacetEnv extends PoolEnv {
  LOADER: WorkerLoader;
  /** Real-DO path reads code straight from R2. */
  CHECKPOINTS?: R2Bucket;
}

interface FacetStub extends Fetcher {
  __poolDump(): Promise<Snapshot>;
  __poolRestore(s: Snapshot): Promise<void>;
  __poolAlarm(info?: { retryCount: number; isRetry: boolean }): Promise<void>;
  __poolClose(code?: number, reason?: string): Promise<void>;
  __poolSockets(): Promise<number>;
}

const FACET = "app";
const PENDING = "_facet_pending";

export class FacetHost extends PortableDurableObject<FacetEnv> {
  static slug = "app";
  /** Namespace binding name, so the control entrypoint can find this object again. */
  static binding = "APPS";

  override async fetch(req: Request): Promise<Response> {
    const want = req.headers.get("x-app-code");
    const current = this.ctx.storage.kv.get<string>("codeId");
    const codeId = want ?? current;
    if (!codeId) return new Response("no app code", { status: 400 });
    if (current !== codeId) {
      if (current) await this.closeFacet(1012, "code updated");
      this.ctx.storage.kv.put("codeId", codeId);
    }
    return (await this.facet()).fetch(req);
  }

  // ---- control surface for the facet (via the FacetCtl entrypoint, scoped to a code id) ----
  private checkCode(codeId: string) {
    // An app can only reach hosts running its own code (not other apps' objects).
    if (this.ctx.storage.kv.get<string>("codeId") !== codeId) throw new Error("not this app's object");
  }
  async facetDirty(codeId: string) {
    this.checkCode(codeId);
    this.markPoolDirty();
  }
  async facetSetAlarm(codeId: string, at: number) {
    this.checkCode(codeId);
    await this.ctx.storage.setAlarm(at);
  }
  async facetGetAlarm(codeId: string) {
    this.checkCode(codeId);
    return this.ctx.storage.getAlarm();
  }
  async facetDeleteAlarm(codeId: string) {
    this.checkCode(codeId);
    await this.ctx.storage.deleteAlarm();
  }

  /** Root alarm = the facet's alarm. */
  async alarm(info?: AlarmInvocationInfo) {
    // AlarmInvocationInfo isn't serialisable over RPC: pass a plain copy.
    await (await this.facet()).__poolAlarm({ retryCount: info?.retryCount ?? 0, isRetry: info?.isRetry ?? false });
  }

  // ---- pool hooks ----
  protected override async poolExtraState() {
    if (!this.ctx.storage.kv.get<string>("codeId")) return undefined;
    return { facet: await (await this.facet()).__poolDump() };
  }

  protected override poolRestoreExtra(extra: unknown) {
    const facet = (extra as { facet?: Snapshot } | undefined)?.facet;
    if (facet) this.ctx.storage.kv.put(PENDING, facet); // applied before the facet's first request
  }

  override async poolSockets() {
    if (!this.ctx.storage.kv.get<string>("codeId")) return 0;
    return (await (await this.facet()).__poolSockets()) + this.ctx.getWebSockets().length;
  }

  override async poolClose(reason = "moved") {
    await this.closeFacet(1012, reason);
    await super.poolClose(reason);
  }

  override async poolRetire() {
    this.ctx.facets.abort(FACET, new Error("moved to another node")); // before deleteAll (see FINDINGS)
    await super.poolRetire();
  }

  private async closeFacet(code: number, reason: string) {
    try {
      await (await this.facet()).__poolClose(code, reason);
    } catch {}
    this.ctx.facets.abort(FACET, new Error(reason));
  }

  private async facet(): Promise<FacetStub> {
    const codeId = this.ctx.storage.kv.get<string>("codeId")!;
    const stub = this.ctx.facets.get(FACET, async () => ({
      class: this.env.LOADER.get(codeId, () => this.loadCode(codeId)).getDurableObjectClass("App"),
    })) as unknown as FacetStub;
    const pending = this.ctx.storage.kv.get<Snapshot>(PENDING);
    if (pending) {
      await stub.__poolRestore(pending);
      this.ctx.storage.kv.delete(PENDING);
    }
    return stub;
  }

  private async loadCode(codeId: string): Promise<WorkerLoaderWorkerCode> {
    let code: string | undefined;
    if (this.pooled) {
      const res = await bridgeFetch(this.env, `/blob/code/${codeId}.js`);
      if (res.ok) code = await res.text();
    } else {
      code = await (await this.env.CHECKPOINTS!.get(`code/${codeId}.js`))?.text();
    }
    if (code === undefined) throw new Error(`app code ${codeId} not found`);
    return {
      compatibilityDate: "2026-09-01",
      mainModule: "shim.js",
      modules: { "shim.js": FACET_SHIM, "user.js": code },
      globalOutbound: null, // apps get no network; add bindings explicitly via env if needed
      // Control stub back to the host (alarm proxy, dirty pings), scoped to this code id.
      // (Cloudflare rejects service stubs in facet *props*; a dynamic Worker's env is fine.)
      env: { __HOST: (this.ctx.exports as any).FacetCtl({ props: { codeId } }) },
    };
  }
}

/** Facet → its host root (alarms, dirty pings), scoped to one code id via props. */
export class FacetCtl extends WorkerEntrypoint<Record<string, DurableObjectNamespace<FacetHost>>, { codeId: string }> {
  private host(name: string) {
    return this.env[FacetHost.binding].getByName(name);
  }
  dirty(name: string) {
    return this.host(name).facetDirty(this.ctx.props.codeId);
  }
  setAlarm(name: string, at: number) {
    return this.host(name).facetSetAlarm(this.ctx.props.codeId, at);
  }
  getAlarm(name: string) {
    return this.host(name).facetGetAlarm(this.ctx.props.codeId);
  }
  deleteAlarm(name: string) {
    return this.host(name).facetDeleteAlarm(this.ctx.props.codeId);
  }
}

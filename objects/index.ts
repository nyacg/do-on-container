import { CursorRoom } from "./cursors";
import { YDoc } from "./doc";
import { Ticker } from "./ticker";
import { Conformance } from "./conformance";
import { FacetHost, FacetCtl } from "./facet-host";
import { BindingsDemo } from "./bindings-demo";
import { AiRoom } from "./ai-room";
import { Lobby } from "./lobby";

export { CursorRoom, YDoc, Ticker, Conformance, FacetHost, FacetCtl, BindingsDemo, AiRoom, Lobby };
export { PortableDurableObject, poolRegistry, poolKey } from "./portable";

/** URL slug → binding name. The same binding names are used on Cloudflare and in the pool. */
export const CLASSES = {
  cursors: { binding: "CURSORS", cls: CursorRoom },
  doc: { binding: "DOC", cls: YDoc },
  ticker: { binding: "TICKER", cls: Ticker },
  conf: { binding: "CONF", cls: Conformance },
  bind: { binding: "BIND", cls: BindingsDemo },
  // Bindings example: AI chat rooms + their lobby (web/public/rooms.html).
  room: { binding: "ROOMS", cls: AiRoom },
  lobby: { binding: "LOBBY", cls: Lobby },
  app: { binding: "APPS", cls: FacetHost },
  // Same app objects, each app in its own sandboxed process (pool only; see container/tenants.ts).
  sapp: { binding: "APPS", cls: FacetHost },
} as const;

export type ClassSlug = keyof typeof CLASSES;

export function isClassSlug(s: string): s is ClassSlug {
  return Object.hasOwn(CLASSES, s);
}

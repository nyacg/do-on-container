import { CursorRoom } from "./cursors";
import { YDoc } from "./doc";
import { Ticker } from "./ticker";

export { CursorRoom, YDoc, Ticker };
export { PortableDurableObject, poolRegistry, poolKey } from "./portable";

/** URL slug → binding name. The same binding names are used on Cloudflare and in the pool. */
export const CLASSES = {
  cursors: { binding: "CURSORS", cls: CursorRoom },
  doc: { binding: "DOC", cls: YDoc },
  ticker: { binding: "TICKER", cls: Ticker },
} as const;

export type ClassSlug = keyof typeof CLASSES;

export function isClassSlug(s: string): s is ClassSlug {
  return Object.hasOwn(CLASSES, s);
}

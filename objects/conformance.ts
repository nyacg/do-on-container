import { PortableDurableObject, type PoolEnv } from "./portable";
import { withConformance } from "./conformance-core";

/** Conformance object as a regular class: real DO on Cloudflare, pooled DO in the container. */
export class Conformance extends withConformance(PortableDurableObject<PoolEnv>) {
  static slug = "conf";
}

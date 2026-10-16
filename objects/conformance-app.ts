/** The conformance object as dynamically loaded app code (bundled to a string; see gen-facet). */
import { DurableObject } from "cloudflare:workers";
import { withConformance } from "./conformance-core";

export class App extends withConformance(DurableObject) {}

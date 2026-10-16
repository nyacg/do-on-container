/**
 * Control-plane Worker (v2): the pool nodes, Placement and the bindings bridge.
 *
 * Kept in its own script because under `scheduling_policy: "durable_object"` a container lives
 * and dies with its DO instance, and every deploy of a script restarts that script's DOs. The
 * edge Worker (src/worker.ts) changes often; this rarely does. Deploying it restarts the nodes
 * (they drain on SIGTERM), so container image updates are rolled out from here too.
 */
export { PoolNodeV2 } from "./pool-node-v2";
export { Placement } from "./placement";
export { Bridge } from "./bridge";

export default {
  fetch() {
    return new Response("do-pool control plane: no public routes", { status: 404 });
  },
} satisfies ExportedHandler;

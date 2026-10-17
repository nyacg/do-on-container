# One sandboxed tenant (app) process: runs the same bundle, but only the FacetHost class, with
# its own data directory and no network. Its only way out is /run/bridge.sock → the router's
# TenantBridge entrypoint, which scopes everything to this tenant. Paths are inside the bwrap
# sandbox (see spawner.sh).
using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "main", worker = .tenant),
    (name = "data", disk = (path = "/data", writable = true)),
    (name = "bridge", external = (address = "unix:/run/bridge.sock", http = ())),
  ],
  sockets = [ (name = "http", address = "unix:/run/slot/http.sock", http = (), service = "main") ],
);

const tenant :Workerd.Worker = (
  modules = [ (name = "app.js", esModule = embed "app.js") ],
  compatibilityDate = "2026-09-01",
  compatibilityFlags = ["nodejs_compat", "no_web_socket_compression"],
  bindings = [
    (name = "APPS", durableObjectNamespace = "FacetHost"),
    (name = "LOADER", workerLoader = (id = "apps")),
    (name = "NODE_NAME", fromEnvironment = "NODE_NAME"),
    (name = "TENANT", fromEnvironment = "TENANT"),
    (name = "__DO_POOL", text = "1"),
  ],
  durableObjectNamespaces = [ (className = "FacetHost", uniqueKey = "do-pool-tenant-apps", enableSql = true) ],
  durableObjectStorage = (localDisk = "data"),
  globalOutbound = "bridge",
);

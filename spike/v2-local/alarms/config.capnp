using Workerd = import "/workerd/workerd.capnp";

# Run from this directory:  workerd serve config.capnp --experimental
# DATA_DIR must exist (localDisk path is relative to cwd unless absolute).
const config :Workerd.Config = (
  services = [
    (name = "main", worker = .w),
    (name = "data", disk = (path = "/tmp/v2-alarms-data", writable = true)),
  ],
  sockets = [ (name = "http", address = "127.0.0.1:8781", http = (), service = "main") ],
);

const w :Workerd.Worker = (
  modules = [ (name = "worker.js", esModule = embed "worker.js") ],
  compatibilityDate = "2026-09-01",
  compatibilityFlags = ["nodejs_compat"],
  bindings = [ (name = "A", durableObjectNamespace = "A") ],
  durableObjectNamespaces = [ (className = "A", uniqueKey = "v2-alarms", enableSql = true) ],
  durableObjectStorage = (localDisk = "data"),
);

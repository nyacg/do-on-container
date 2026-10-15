using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "main", worker = .mainWorker),
    (name = "data", disk = (path = "/tmp/spike-data", writable = true)),
  ],
  sockets = [ (name = "http", address = "*:8080", http = (), service = "main") ],
);

const mainWorker :Workerd.Worker = (
  modules = [ (name = "worker.js", esModule = embed "worker.js") ],
  compatibilityDate = "2026-09-01",
  compatibilityFlags = ["nodejs_compat"],
  bindings = [ (name = "ROOM", durableObjectNamespace = "Room") ],
  durableObjectNamespaces = [ (className = "Room", uniqueKey = "spike-room", enableSql = true, preventEviction = true) ],
  durableObjectStorage = (localDisk = "data"),
);

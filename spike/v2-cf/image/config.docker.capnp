using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "main", worker = .mainWorker),
    (name = "data", disk = (path = "/data", writable = true)),
    (name = "stats", disk = (path = "/stats")),
    (name = "net", network = (allow = ["public", "private", "local"])),
  ],
  sockets = [ (name = "http", address = "*:8080", http = (), service = "main") ],
);

const mainWorker :Workerd.Worker = (
  modules = [ (name = "worker.js", esModule = embed "worker.js") ],
  compatibilityDate = "2026-09-01",
  compatibilityFlags = ["no_web_socket_compression"],
  bindings = [ (name = "ROOM", durableObjectNamespace = "Room"), (name = "STATS", service = "stats") ],
  durableObjectNamespaces = [ (className = "Room", uniqueKey = "spike-room", enableSql = true) ],
  durableObjectStorage = (localDisk = "data"),
  globalOutbound = "net",
);

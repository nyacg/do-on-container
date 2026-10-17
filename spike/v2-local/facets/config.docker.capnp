using Workerd = import "/workerd/workerd.capnp";

# workerd serve config.capnp --experimental   (from this directory)
const config :Workerd.Config = (
  services = [
    (name = "main", worker = .host),
    (name = "data", disk = (path = "/tmp/v2-facets-data", writable = true)),
    (name = "net", network = (allow = ["public"])),
  ],
  sockets = [ (name = "http", address = "*:8783", http = (), service = "main") ],
);

const host :Workerd.Worker = (
  modules = [
    (name = "host.js", esModule = embed "host.js"),
    (name = "app.js", text = embed "app.js"),
  ],
  compatibilityDate = "2026-09-01",
  compatibilityFlags = [],
  bindings = [
    (name = "LOADER", workerLoader = (id = "apps")),
    (name = "RUNNER", durableObjectNamespace = "AppRunner"),
  ],
  durableObjectNamespaces = [ (className = "AppRunner", uniqueKey = "v2-apprunner", enableSql = true) ],
  durableObjectStorage = (localDisk = "data"),
  globalOutbound = "net",
);

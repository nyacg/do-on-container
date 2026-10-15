using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "main", worker = .router),
    (name = "data", disk = (path = "/data", writable = true)),
    (name = "stats", disk = (path = "/stats")),
    # The container's egress is intercepted by the PoolNode's outbound handlers
    # (http://bridge.internal → Worker bindings), so allow private ranges too.
    (name = "net", network = (allow = ["public", "private", "local"])),
  ],
  sockets = [ (name = "http", address = "*:8080", http = (), service = "main") ],
);

const router :Workerd.Worker = (
  modules = [ (name = "app.js", esModule = embed "dist/app.js") ],
  compatibilityDate = "2026-09-01",
  # Browsers always offer permessage-deflate; a zlib context costs ~300KB per socket.
  compatibilityFlags = ["nodejs_compat", "no_web_socket_compression"],
  bindings = [
    (name = "CURSORS", durableObjectNamespace = "CursorRoom"),
    (name = "DOC", durableObjectNamespace = "YDoc"),
    (name = "TICKER", durableObjectNamespace = "Ticker"),
    (name = "STATS", service = "stats"),
    (name = "NODE_NAME", fromEnvironment = "NODE_NAME"),
    (name = "__DO_POOL", text = "1"),
  ],
  durableObjectNamespaces = [
    (className = "CursorRoom", uniqueKey = "do-pool-cursors", enableSql = true),
    (className = "YDoc", uniqueKey = "do-pool-doc", enableSql = true),
    (className = "Ticker", uniqueKey = "do-pool-ticker", enableSql = true),
  ],
  durableObjectStorage = (localDisk = "data"),
  globalOutbound = "net",
);

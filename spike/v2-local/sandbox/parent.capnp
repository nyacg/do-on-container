# Parent ("router") workerd: forwards /t1/* to the sandboxed tenant workerd over its unix socket.
using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "main", worker = .router),
    (name = "t1", external = (address = "unix:/tenants/t1/run/http.sock", http = ())),
  ],
  sockets = [ (name = "http", address = "*:8080", http = (), service = "main") ],
);

const router :Workerd.Worker = (
  modules = [ (name = "r.js", esModule = "export default { fetch: (req, env) => env.T1.fetch(req) };") ],
  compatibilityDate = "2026-09-01",
  bindings = [ (name = "T1", service = "t1") ],
);

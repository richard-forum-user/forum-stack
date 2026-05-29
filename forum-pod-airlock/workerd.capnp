using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "http", network = (
      ssl = void,
      address = "127.0.0.1:8787",
    ), service = "podWorker"),
  ],
  sockets = [
    (name = "http", address = "127.0.0.1:8787", service = "podWorker"),
  ],
);

const podWorker :Workerd.Worker = (
  modules = [
    (name = "secure-worker", esModule = embed "secure-worker.js"),
    (name = "pod-do", esModule = embed "pod-do.js"),
    (name = "pod-signing-web", esModule = embed "pod-signing-web.js"),
    (name = "session-binding", esModule = embed "session-binding.js"),
    (name = "unlock-token", esModule = embed "unlock-token.js"),
    (name = "rate-limit", esModule = embed "rate-limit.js"),
    (name = "do-guards", esModule = embed "do-guards.js"),
    (name = "webauthn-server", esModule = embed "webauthn-server.js"),
    (name = "feedback-limits", esModule = embed "feedback-limits.js"),
    (name = "secret-compare", esModule = embed "secret-compare.js"),
    (name = "member-hash", esModule = embed "member-hash.js"),
    (name = "membership-verify", esModule = embed "membership-verify.js"),
    (name = "membership-routes", esModule = embed "membership-routes.js"),
    (name = "pod-sync", esModule = embed "pod-sync.js"),
  ],
  bindings = [
    (name = "POD", durableObjectNamespace = (
      className = "PersonalPodDO",
      uniqueKey = "forum-stack-local",
    )),
    (name = "COOP_URL", text = "https://coop.yourcommunity.forum"),
  ],
  durableObjectNamespaces = [
    (name = "POD", className = "PersonalPodDO", uniqueKey = "forum-stack-local"),
  ],
);

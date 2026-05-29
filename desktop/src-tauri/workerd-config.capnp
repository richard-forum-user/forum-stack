using Workerd = import "/workerd/workerd.capnp";

# Strictly localhost. The Tauri shell rewrites {PORT} at launch to a
# free random port so multiple installs on the same machine never
# collide.
const config :Workerd.Config = (
  services = [
    (name = "podWorker", worker = .podWorker),
    (name = "podDiskStore", disk = (path = "{DATA_DIR}", writable = true)),
  ],
  sockets = [
    (name = "http", address = "127.0.0.1:{PORT}", service = "podWorker"),
  ],
);

const podWorker :Workerd.Worker = (
  modules = [
    (name = "secure-worker", esModule = embed "{AIRLOCK_DIR}/secure-worker.js"),
    (name = "pod-do", esModule = embed "{AIRLOCK_DIR}/pod-do.js"),
    (name = "pod-signing-web", esModule = embed "{AIRLOCK_DIR}/pod-signing-web.js"),
    (name = "session-binding", esModule = embed "{AIRLOCK_DIR}/session-binding.js"),
    (name = "unlock-token", esModule = embed "{AIRLOCK_DIR}/unlock-token.js"),
    (name = "rate-limit", esModule = embed "{AIRLOCK_DIR}/rate-limit.js"),
    (name = "do-guards", esModule = embed "{AIRLOCK_DIR}/do-guards.js"),
    (name = "webauthn-server", esModule = embed "{AIRLOCK_DIR}/webauthn-server.js"),
    (name = "feedback-limits", esModule = embed "{AIRLOCK_DIR}/feedback-limits.js"),
    (name = "secret-compare", esModule = embed "{AIRLOCK_DIR}/secret-compare.js"),
    (name = "member-hash", esModule = embed "{AIRLOCK_DIR}/member-hash.js"),
    (name = "membership-verify", esModule = embed "{AIRLOCK_DIR}/membership-verify.js"),
    (name = "membership-routes", esModule = embed "{AIRLOCK_DIR}/membership-routes.js"),
    (name = "pod-sync", esModule = embed "{AIRLOCK_DIR}/pod-sync.js"),
  ],
  bindings = [
    (name = "COOP_URL", text = "https://coop.yourcommunity.forum"),
  ],
  durableObjectNamespaces = [
    (name = "POD", className = "PersonalPodDO", uniqueKey = "forum-stack-desktop"),
  ],
  durableObjectStorage = (localDisk = "podDiskStore"),
);

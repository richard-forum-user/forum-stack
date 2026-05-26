#!/usr/bin/env bash
set -euo pipefail

# Installs a local Ollama runtime for the Forum Pod Civic AI Kami and exposes it
# through the existing Cloudflare Tunnel. Run on the GPU host.
#
# Optional Cloudflare Access automation needs:
#   CF_ACCOUNT_ID, CF_API_TOKEN
# The token must be allowed to manage Zero Trust Access applications/policies.

AI_HOSTNAME="${AI_HOSTNAME:-ai.yourcommunity.forum}"
OLLAMA_MODEL="${OLLAMA_MODEL:-qwen2.5:14b-instruct-q4_K_M}"
OLLAMA_HOST_BIND="${OLLAMA_HOST_BIND:-127.0.0.1:11434}"
OLLAMA_ORIGINS="${OLLAMA_ORIGINS:-https://${AI_HOSTNAME},https://ai-open.yourcommunity.forum}"
CLOUDFLARED_CONFIG="${CLOUDFLARED_CONFIG:-/etc/cloudflared/config.yml}"

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

require_root_for_systemd() {
  if [[ "${EUID}" -ne 0 ]]; then
    echo "This script needs root for systemd/cloudflared config writes. Re-run with sudo." >&2
    exit 1
  fi
}

install_ollama() {
  if ! command -v ollama >/dev/null 2>&1; then
    need_cmd curl
    curl -fsSL https://ollama.com/install.sh | sh
  fi

  mkdir -p /etc/systemd/system/ollama.service.d
  cat >/etc/systemd/system/ollama.service.d/forum-civic-ai.conf <<EOF
[Service]
Environment=OLLAMA_HOST=${OLLAMA_HOST_BIND}
Environment=OLLAMA_KEEP_ALIVE=30m
Environment=OLLAMA_NUM_PARALLEL=2
Environment=OLLAMA_ORIGINS=${OLLAMA_ORIGINS}
EOF

  systemctl daemon-reload
  systemctl enable --now ollama
  ollama pull "${OLLAMA_MODEL}"
}

ensure_cloudflared_ingress() {
  if ! command -v cloudflared >/dev/null 2>&1; then
    echo "cloudflared is not installed; skipping tunnel config write." >&2
    echo "Add this ingress rule manually once cloudflared is installed:" >&2
    print_ingress_rule >&2
    return
  fi

  if [[ ! -f "${CLOUDFLARED_CONFIG}" ]]; then
    echo "cloudflared config not found at ${CLOUDFLARED_CONFIG}; skipping tunnel config write." >&2
    echo "Set CLOUDFLARED_CONFIG=/path/to/config.yml or add this ingress rule manually:" >&2
    print_ingress_rule >&2
    return
  fi

  if grep -q "hostname: ${AI_HOSTNAME}" "${CLOUDFLARED_CONFIG}"; then
    echo "cloudflared ingress for ${AI_HOSTNAME} already exists."
    return
  fi

  cp "${CLOUDFLARED_CONFIG}" "${CLOUDFLARED_CONFIG}.bak.$(date +%Y%m%d%H%M%S)"
  python3 - "${CLOUDFLARED_CONFIG}" "${AI_HOSTNAME}" "${OLLAMA_HOST_BIND}" <<'PY'
from pathlib import Path
import sys

config_path = Path(sys.argv[1])
hostname = sys.argv[2]
host_bind = sys.argv[3]
text = config_path.read_text()
rule = f"  - hostname: {hostname}\n    service: http://{host_bind}\n"

if "ingress:" not in text:
    text = text.rstrip() + "\ningress:\n" + rule + "  - service: http_status:404\n"
elif "  - service: http_status:404" in text:
    text = text.replace("  - service: http_status:404", rule + "  - service: http_status:404", 1)
else:
    text = text.rstrip() + "\n" + rule

config_path.write_text(text)
PY
  systemctl restart cloudflared || echo "Restart cloudflared manually if this host uses a non-systemd service."
}

print_ingress_rule() {
  cat <<EOF
- hostname: ${AI_HOSTNAME}
  service: http://${OLLAMA_HOST_BIND}
EOF
}

create_access_policy_if_requested() {
  if [[ -z "${CF_ACCOUNT_ID:-}" || -z "${CF_API_TOKEN:-}" ]]; then
    cat <<EOF

Cloudflare Access was not configured automatically.
Create a self-hosted Access application for https://${AI_HOSTNAME} and a service-token-only policy.
Then set these Worker secrets:

  npx wrangler secret put AI_ACCESS_CLIENT_ID
  npx wrangler secret put AI_ACCESS_CLIENT_SECRET

EOF
    return
  fi

  need_cmd curl
  need_cmd python3

  local app_payload app_id token_payload token_id client_id client_secret policy_payload
  app_payload="$(python3 - "${AI_HOSTNAME}" <<'PY'
import json, sys
hostname = sys.argv[1]
print(json.dumps({
  "name": "Forum Pod Civic AI Ollama",
  "domain": hostname,
  "type": "self_hosted",
  "session_duration": "24h",
  "allowed_idps": [],
  "auto_redirect_to_identity": False,
}))
PY
)"

  app_id="$(curl -fsS "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/access/apps" \
    -H "Authorization: Bearer ${CF_API_TOKEN}" \
    -H "Content-Type: application/json" \
    --data "${app_payload}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["id"])')"

  token_payload='{"name":"secure-worker-to-ollama"}'
  token_json="$(curl -fsS "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/access/service_tokens" \
    -H "Authorization: Bearer ${CF_API_TOKEN}" \
    -H "Content-Type: application/json" \
    --data "${token_payload}")"
  token_id="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["id"])' <<<"${token_json}")"
  client_id="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["client_id"])' <<<"${token_json}")"
  client_secret="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["client_secret"])' <<<"${token_json}")"

  policy_payload="$(python3 - "${token_id}" <<'PY'
import json, sys
token_id = sys.argv[1]
print(json.dumps({
  "name": "Allow secure-worker service token",
  "decision": "non_identity",
  "include": [{"service_token": {"token_id": token_id}}],
}))
PY
)"

  curl -fsS "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/access/apps/${app_id}/policies" \
    -H "Authorization: Bearer ${CF_API_TOKEN}" \
    -H "Content-Type: application/json" \
    --data "${policy_payload}" >/dev/null

  cat <<EOF

Cloudflare Access configured.

Application id: ${app_id}
Service token id: ${token_id}

Set Worker secrets:

  printf '%s' '${client_id}' | npx wrangler secret put AI_ACCESS_CLIENT_ID
  printf '%s' '${client_secret}' | npx wrangler secret put AI_ACCESS_CLIENT_SECRET

EOF
}

main() {
  require_root_for_systemd
  need_cmd python3
  install_ollama
  ensure_cloudflared_ingress
  create_access_policy_if_requested

  cat <<EOF
Ollama is listening on ${OLLAMA_HOST_BIND}.
Model pulled: ${OLLAMA_MODEL}

Local health check:
  curl -fsS http://${OLLAMA_HOST_BIND}/api/version

Tunnel health check after Access secrets are set:
  curl -fsS https://${AI_HOSTNAME}/api/version \\
    -H "CF-Access-Client-Id: <AI_ACCESS_CLIENT_ID>" \\
    -H "CF-Access-Client-Secret: <AI_ACCESS_CLIENT_SECRET>"
EOF
}

main "$@"

#!/bin/bash
# Altare start script: runs the Nous proxy + Hermes adapter + Claw3D Studio in one container.
# All secrets come from Altare env vars (never committed to the repo):
#   NOUS_ACCESS_TOKEN, NOUS_REFRESH_TOKEN - Nous Portal OAuth session (dedicated to Altare)
#   CLAW3D_GATEWAY_TOKEN - internal token shared by the Studio proxy and the adapter
#   HERMES_MODEL - e.g. qwen/qwen4-max:free
# Altare provides PORT; the Studio listens on 0.0.0.0:$PORT.
set -e
cd "$(dirname "$0")"

# 1. Studio gateway settings (the server-side loader reads ONLY this file, not .env).
mkdir -p "${HOME}/.openclaw/claw3d"
GATEWAY_TOKEN="${CLAW3D_GATEWAY_TOKEN:-claw3d-local-token}"
cat > "${HOME}/.openclaw/claw3d/settings.json" <<EOF
{"gateway": {"url": "ws://localhost:18789", "token": "${GATEWAY_TOKEN}", "adapterType": "hermes"}}
EOF

# 2. Nous proxy (OpenAI-compatible, auto-refreshing) on 127.0.0.1:8642.
export NOUS_PROXY_PORT=8642
export NOUS_TOKEN_FILE="${HOME}/.nous-tokens.json"
node nous-proxy.js > /tmp/nous-proxy.log 2>&1 &
echo "[start] nous-proxy pid $!"

# 3. Hermes adapter on 127.0.0.1:18789 (talks to the proxy above).
export HERMES_API_URL="http://localhost:8642"
export HERMES_MODEL="${HERMES_MODEL:-qwen/qwen4-max:free}"
export HERMES_AGENT_NAME="${HERMES_AGENT_NAME:-Hermes}"
export CLAW3D_GATEWAY_TOKEN="${GATEWAY_TOKEN}"
node server/hermes-gateway-adapter.js > /tmp/claw3d-adapter.log 2>&1 &
echo "[start] adapter pid $!"

# 4. Studio (foreground). Altare sets PORT; bind all interfaces.
export HOST="0.0.0.0"
export PORT="${PORT:-3000}"
export UPSTREAM_ALLOWLIST="localhost,127.0.0.1"
export NODE_ENV="production"
echo "[start] studio on 0.0.0.0:${PORT}"
exec npm start

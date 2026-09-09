#!/usr/bin/env bash
# Start the OpenCode Master in direct-gateway mode: Master talks the native
# opencode API on the Docker runtime directly (no Worker process), while a
# lightweight heartbeat script registers that instance and reports its health.
#
# Requires the Docker opencode runtime on OPENCODE_URL to be already running
# (packages/worker runtime.compose.yml) and PostgreSQL on OPENCODE_DB_URL.
#
# Usage:
#   scripts/start-master-direct.sh          # defaults below
#   OPENCODE_MASTER_PORT=4001 scripts/start-master-direct.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="$ROOT_DIR/.run"
PID_FILE="$STATE_DIR/master.pid"
HB_PID_FILE="$STATE_DIR/heartbeat.pid"
LOG_FILE="$STATE_DIR/master.log"
HB_LOG_FILE="$STATE_DIR/heartbeat.log"

MASTER_PORT="${OPENCODE_MASTER_PORT:-4000}"
MASTER_HOST="${OPENCODE_MASTER_HOST:-0.0.0.0}"
MASTER_DB="${OPENCODE_MASTER_DB:-$ROOT_DIR/data/master.db}"
BOOTSTRAP_KEY="${OPENCODE_MASTER_BOOTSTRAP_KEY:-dev-admin-key}"
JWT_SECRET="${OPENCODE_MASTER_JWT_SECRET:-dev-secret-change-me}"

# The native opencode runtime (Docker). The Master connects directly.
OPENCODE_URL="${OPENCODE_MASTER_OPENCODE_URL:-http://127.0.0.1:4096}"
# Container-visible workspace root: Master maps logical `/workspace/<user>` to
# `<OPENCODE_MASTER_WORKSPACE_ROOT>/<user>` so the instance can resolve it.
OPENCODE_WORKSPACE_ROOT="${OPENCODE_MASTER_WORKSPACE_ROOT:-/Users/jero/Documents/code/opencode}"
# Optional model override (e.g. deepseek/deepseek-v4-pro). Leave empty to use
# the instance's default model.
OPENCODE_MODEL="${OPENCODE_MASTER_OPENCODE_MODEL:-}"

# Heartbeat keep-alive identity.
HB_ID="${OPENCODE_HEARTBEAT_ID:-opencode-1}"
HB_REGION="${OPENCODE_HEARTBEAT_REGION:-cn-north-1}"
HB_CAPACITY="${OPENCODE_HEARTBEAT_CAPACITY:-3}"

mkdir -p "$STATE_DIR"

stop() {
  if [ -f "$HB_PID_FILE" ]; then
    kill "$(cat "$HB_PID_FILE")" >/dev/null 2>&1 || true
    rm -f "$HB_PID_FILE"
  fi
  if [ -f "$PID_FILE" ]; then
    kill "$(cat "$PID_FILE")" >/dev/null 2>&1 || true
    rm -f "$PID_FILE"
  fi
}
trap stop INT TERM EXIT

echo "Starting OpenCode Master (direct-gateway) on http://${MASTER_HOST}:${MASTER_PORT}"
notify_env=()
if [ -n "$OPENCODE_MODEL" ]; then
  notify_env+=("OPENCODE_MASTER_OPENCODE_MODEL=$OPENCODE_MODEL")
fi
env MASTER_PORT="$MASTER_PORT" \
  OPENCODE_MASTER_PORT="$MASTER_PORT" \
  OPENCODE_MASTER_HOST="$MASTER_HOST" \
  OPENCODE_MASTER_DB="$MASTER_DB" \
  OPENCODE_MASTER_BOOTSTRAP_KEY="$BOOTSTRAP_KEY" \
  OPENCODE_MASTER_JWT_SECRET="$JWT_SECRET" \
  OPENCODE_MASTER_OPENCODE_URL="$OPENCODE_URL" \
  OPENCODE_MASTER_WORKSPACE_ROOT="$OPENCODE_WORKSPACE_ROOT" \
  OPENCODE_MASTER_OPENCODE_MODEL="$OPENCODE_MODEL" \
  bun run "$ROOT_DIR/src/index.ts" >"$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"

echo "Starting OpenCode heartbeat keep-alive ($HB_ID @ $OPENCODE_URL)"
bun run "$ROOT_DIR/scripts/opencode-heartbeat.ts" \
  --master "http://127.0.0.1:${MASTER_PORT}" \
  --api-key "$BOOTSTRAP_KEY" \
  --id "$HB_ID" \
  --opencode-url "$OPENCODE_URL" \
  --region "$HB_REGION" \
  --capacity "$HB_CAPACITY" >"$HB_LOG_FILE" 2>&1 &
echo $! > "$HB_PID_FILE"

# Wait for the Master to be reachable.
ready=false
i=0
while [ "$i" -lt 30 ]; do
  if curl -fsS "http://127.0.0.1:${MASTER_PORT}/healthz" >/dev/null 2>&1; then
    ready=true
    break
  fi
  if ! kill -0 "$(cat "$PID_FILE")" >/dev/null 2>&1; then
    echo "Master exited during startup" >&2
    tail -40 "$LOG_FILE" >&2 || true
    exit 1
  fi
  sleep 1
  i=$((i + 1))
done

if [ "$ready" != true ]; then
  echo "Timed out waiting for Master" >&2
  tail -40 "$LOG_FILE" >&2 || true
  exit 1
fi

echo "Master is ready."
echo "  Console: http://localhost:${MASTER_PORT}"
echo "  Opencode: ${OPENCODE_URL}"
echo "  Workspace root: ${OPENCODE_WORKSPACE_ROOT}"
echo "  Heartbeat: ${HB_ID}"
echo "  Logs: ${LOG_FILE} (master), ${HB_LOG_FILE} (heartbeat)"

wait "$(cat "$PID_FILE")"

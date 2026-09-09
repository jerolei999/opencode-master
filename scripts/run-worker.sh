#!/bin/bash
# Start one OpenCode Worker. Master is the only client of its private proxy.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ID="${1:?worker id required}"
OPENCODE_PORT="${2:?opencode port required}"
WORKER_PORT="${3:?worker proxy port required}"
KEY_FILE="${OPENCODE_DEEPSEEK_KEY_FILE:-$HOME/.config/opencode-master/deepseek.key}"
CREDENTIAL="${OPENCODE_WORKER_PROXY_CREDENTIAL:?OPENCODE_WORKER_PROXY_CREDENTIAL is required}"

if [[ ! -f "$KEY_FILE" ]]; then
  echo "missing provider credential file" >&2
  exit 1
fi

exec env DEEPSEEK_API_KEY="$(cat "$KEY_FILE")" "$HOME/.bun/bin/bun" run "$ROOT/src/worker/index.ts" \
  --id "$ID" --port "$WORKER_PORT" --opencode-port "$OPENCODE_PORT" \
  --credential "$CREDENTIAL" --master "${OPENCODE_MASTER_URL:-http://127.0.0.1:4299}" \
  --api-key dev-admin-key --opencode-bin "$ROOT/scripts/opencode-serve.sh" \
  --workspace-dir "${OPENCODE_SHARED_WORKSPACE:-/tmp/om-shared-workspace}" \
  --data-dir "/tmp/om-worker-$ID"

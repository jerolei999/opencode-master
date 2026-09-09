#!/bin/bash
# Manage the master: start / stop / status.
# Usage:
#   scripts/run-master.sh start
#   scripts/run-master.sh stop
#   scripts/run-master.sh status
#   scripts/run-master.sh foreground   # for launchd/systemd/container supervision
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUN="$HOME/.bun/bin/bun"
ACTION="${1:-}"
PIDS_DIR="$ROOT/.run"
PORT=4299
# Persistent DB location (survives reboots; /tmp does not)
DB="${OPENCODE_MASTER_DB:-$HOME/.config/opencode-master/master.db}"
ENV="${OPENCODE_MASTER_ENV:-test}"

if [[ -z "$ACTION" ]]; then
  echo "usage: $0 start|stop|status|foreground" >&2
  exit 2
fi

case "$ACTION" in
  start)
    lsof -tiTCP:$PORT -sTCP:LISTEN 2>/dev/null | xargs -r kill -TERM || true
    sleep 2
    mkdir -p "$PIDS_DIR"
    nohup env OPENCODE_MASTER_PORT=$PORT OPENCODE_MASTER_DB="$DB" OPENCODE_MASTER_ENV="$ENV" \
      "$BUN" run "$ROOT/src/index.ts" >/tmp/om-web2-master.log 2>&1 &
    disown
    echo $! > "$PIDS_DIR/master.pid"
    echo "started master on :$PORT (pid $(cat "$PIDS_DIR/master.pid"), log /tmp/om-web2-master.log)"
    ;;
  foreground)
    # A process manager must own this process. `nohup` cannot provide restart
    # guarantees and is especially unreliable when the invoking shell exits.
    exec env OPENCODE_MASTER_PORT=$PORT OPENCODE_MASTER_DB="$DB" OPENCODE_MASTER_ENV="$ENV" \
      "$BUN" run "$ROOT/src/index.ts"
    ;;
  stop)
    lsof -tiTCP:$PORT -sTCP:LISTEN 2>/dev/null | xargs -r kill -TERM || true
    rm -f "$PIDS_DIR/master.pid"
    echo "stopped master"
    ;;
  status)
    if lsof -tiTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
      echo "master: running (port $PORT)"
    else
      echo "master: stopped"
    fi
    ;;
  *)
    echo "unknown action: $ACTION" >&2
    exit 2
    ;;
esac

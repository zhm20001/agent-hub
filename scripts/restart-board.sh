#!/usr/bin/env bash
# Kill whatever is listening on PORT (default 3000), then start the Agent Hub board.
# Why: Vite HMR updates the frontend only — Express API routes in src/server.ts do NOT
# hot-reload. After any server/API change you need a full process restart.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
PORT="${PORT:-3000}"

kill_port() {
  local pids
  pids="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -z "${pids}" ]]; then
    echo "[Agent Hub] nothing listening on :${PORT}"
    return 0
  fi
  echo "[Agent Hub] killing listener(s) on :${PORT}: ${pids}"
  # shellcheck disable=SC2086
  kill ${pids} 2>/dev/null || true
  sleep 0.4
  pids="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "${pids}" ]]; then
    # shellcheck disable=SC2086
    kill -9 ${pids} 2>/dev/null || true
    sleep 0.2
  fi
}

kill_port
echo "[Agent Hub] starting board (PORT=${PORT})…"
exec npm run start

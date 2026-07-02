#!/usr/bin/env bash
# Conformance MATRIX: boot one real lukk instance and run the JS client flows
# against it in every feature / signing-algorithm / delivery combination, proving
# the whole surface works end-to-end — not just in unit tests.
#
# Builds the fixture ONCE, then per combo rewrites .env, resets the DB, restarts
# `php artisan serve`, and runs the (feature-gated) conformance suite.
#
# Usage:
#   [LUKK_PATH=/abs/path/to/lukk] [LUKK_APP_DIR=/tmp/lukk-matrix-app] conformance/matrix.sh
#
#   LUKK_PATH — test your local lukk working copy instead of the published one.
#
# Needs: php >= 8.3, composer, node/pnpm, curl. Native (no Docker).
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"
APP_DIR="${LUKK_APP_DIR:-${TMPDIR:-/tmp}/lukk-matrix-app}"
PORT="${LUKK_PORT:-8000}"
ENV_FILE="$APP_DIR/.env"
SERVE_PID=""

RSA_PRIV="@$APP_DIR/storage/lukk_rsa_private.pem"; RSA_PUB="@$APP_DIR/storage/lukk_rsa_public.pem"
EC_PRIV="@$APP_DIR/storage/lukk_ec_private.pem";   EC_PUB="@$APP_DIR/storage/lukk_ec_public.pem"

# Kill a server WE started — the pid and all its descendants. `artisan serve` spawns a
# `php -S` child, so killing just the (sub)shell pid leaves the worker holding the port;
# this recurses so nothing is orphaned. It only ever touches our own process tree — never
# a process on the port we didn't start (that's what `require_port_free` guards).
kill_tree() {
  local pid="$1" child
  [ -n "$pid" ] || return 0
  for child in $(pgrep -P "$pid" 2>/dev/null); do kill_tree "$child"; done
  kill -9 "$pid" 2>/dev/null
}
# Abort (do NOT kill) if a port we need is already held by a foreign process.
require_port_free() {
  local port="$1" pids
  pids="$(lsof -ti "tcp:$port" -sTCP:LISTEN 2>/dev/null)" || true
  [ -z "$pids" ] && return 0
  echo "✗ port $port is already in use — refusing to kill a process we didn't start:"
  # shellcheck disable=SC2086
  ps -o pid=,command= -p $pids 2>/dev/null | sed 's/^/    /'
  echo "  stop it, or re-run with a different port: LUKK_PORT=<n> $0"
  exit 1
}
# Wait (bounded) for a port to free after we kill our server, before rebinding.
wait_port_free() { for _ in $(seq 1 30); do lsof -ti "tcp:$1" -sTCP:LISTEN >/dev/null 2>&1 || return 0; sleep 0.1; done; return 1; }
cleanup() { kill_tree "$SERVE_PID"; }
trap cleanup INT TERM EXIT

# --- update-or-append KEY=VALUE in .env ---
set_env() {
  local key="$1" val="$2"
  if grep -q "^${key}=" "$ENV_FILE"; then
    # Use a temp file (portable sed -i across GNU/BSD).
    grep -v "^${key}=" "$ENV_FILE" > "$ENV_FILE.tmp" && mv "$ENV_FILE.tmp" "$ENV_FILE"
  fi
  printf '%s=%s\n' "$key" "$val" >> "$ENV_FILE"
}

wait_for_up() {
  for _ in $(seq 1 40); do
    curl -fsS "http://127.0.0.1:$PORT/up" >/dev/null 2>&1 && return 0
    sleep 0.25
  done
  return 1
}

RESULTS=()
FAILED=0

run_combo() {
  local name="$1" algo="$2" f2fa="$3" fpk="$4" femail="$5" cookie="$6"

  # Signing algorithm + keys.
  set_env LUKK_ALGORITHM "$algo"
  case "$algo" in
    RS256) set_env LUKK_ACTIVE_KID conformance; set_env LUKK_PRIVATE_KEY "$RSA_PRIV"; set_env LUKK_PUBLIC_KEY "$RSA_PUB" ;;
    ES256) set_env LUKK_ACTIVE_KID conformance; set_env LUKK_PRIVATE_KEY "$EC_PRIV";  set_env LUKK_PUBLIC_KEY "$EC_PUB" ;;
    *)     set_env LUKK_ACTIVE_KID ""; set_env LUKK_PRIVATE_KEY ""; set_env LUKK_PUBLIC_KEY "" ;; # HS256 ignores these
  esac

  set_env LUKK_FEAT_2FA "$f2fa"
  set_env LUKK_FEAT_PASSKEYS "$fpk"
  set_env LUKK_FEAT_EMAIL "$femail"
  set_env LUKK_COOKIE_MODE "$cookie"

  if ! ( cd "$APP_DIR" && php artisan optimize:clear >/dev/null && php artisan migrate:fresh --force >/dev/null && php artisan db:seed --force >/dev/null ); then
    echo "✗ [$name] DB reset failed"; RESULTS+=("✗ $name (db reset failed)"); FAILED=1; return
  fi

  wait_port_free "$PORT" || { echo "✗ [$name] port $PORT still held after killing the previous combo's server"; RESULTS+=("✗ $name (port stuck)"); FAILED=1; return; }
  ( cd "$APP_DIR" && php artisan serve --host=127.0.0.1 --port="$PORT" >/tmp/lukk-serve.log 2>&1 ) &
  SERVE_PID=$!
  if ! wait_for_up; then
    echo "✗ [$name] server did not come up — see /tmp/lukk-serve.log"
    RESULTS+=("✗ $name (boot failed)"); FAILED=1
    kill_tree "$SERVE_PID"; SERVE_PID=""; return
  fi

  echo "── running: $name ────────────────────────────────────────────"
  if LUKK_URL="http://127.0.0.1:$PORT/auth" LUKK_COOKIE_MODE="$cookie" LUKK_ALGORITHM="$algo" \
     LUKK_FEAT_2FA="$f2fa" LUKK_FEAT_PASSKEYS="$fpk" LUKK_FEAT_EMAIL="$femail" \
     pnpm --dir "$REPO_ROOT" --filter lukk-core test:conformance; then
    RESULTS+=("✓ $name")
  else
    RESULTS+=("✗ $name"); FAILED=1
  fi

  kill_tree "$SERVE_PID"; SERVE_PID=""
}

require_port_free "$PORT"

echo "▶ building the conformance fixture once in $APP_DIR ..."
LUKK_PATH="${LUKK_PATH:-}" bash "$HERE/fixture/build.sh" "$APP_DIR" || { echo "✗ fixture build failed"; exit 1; }

#         name                          algo   2fa    passkeys email  cookie
run_combo "features:none  (HS256/body)" HS256  false  false    false  false
run_combo "2fa            (HS256/body)" HS256  true   false    false  false
run_combo "passkeys       (HS256/body)" HS256  false  true     false  false
run_combo "email          (HS256/body)" HS256  false  false    true   false
run_combo "passkeys+email (HS256/body)" HS256  false  true     true   false
run_combo "2fa+passkeys   (HS256/body)" HS256  true   true     false  false
run_combo "all-features   (HS256/body)" HS256  true   true     true   false
run_combo "all-features   (HS256/cookie)" HS256 true  true     true   true
run_combo "all-features   (RS256/body)" RS256  true   true     true   false
run_combo "all-features   (ES256/body)" ES256  true   true     true   false

echo
echo "════════════════ conformance matrix summary ════════════════"
printf '%s\n' "${RESULTS[@]}"
echo "═════════════════════════════════════════════════════════════"
exit $FAILED

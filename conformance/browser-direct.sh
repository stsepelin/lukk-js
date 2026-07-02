#!/usr/bin/env bash
# Browser E2E for the DIRECT transport (SPA + SSG), same-origin with the lukk API.
# Runs the flows in a real Chromium for BOTH build modes:
#   spa → `nuxi build` (ssr:false), served by the Nitro preview
#   ssg → `nuxi generate`, served as static files
# The app and API share one https origin via conformance/apps/nuxt-direct/e2e/serve-direct.mjs.
#
# Usage:  [LUKK_PATH=/abs/path/to/lukk] conformance/browser-direct.sh [spa|ssg|both]
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"
APP_DIR="${LUKK_APP_DIR:-${TMPDIR:-/tmp}/lukk-direct-api}"
NUXT_APP="$REPO_ROOT/conformance/apps/nuxt-direct"
ENV_FILE="$APP_DIR/.env"
WHICH="${1:-both}"
API_PID=""

# Kill a server WE started — the pid + its descendants (artisan serve spawns a php -S
# child). Only ever touches our own tree; never a foreign process on the port.
kill_tree() {
  local pid="$1" child
  [ -n "$pid" ] || return 0
  for child in $(pgrep -P "$pid" 2>/dev/null); do kill_tree "$child"; done
  kill -9 "$pid" 2>/dev/null
}
# Abort (do NOT kill) if a needed port is held by a foreign process — it might be your app.
require_port_free() {
  local port="$1" pids
  pids="$(lsof -ti "tcp:$port" -sTCP:LISTEN 2>/dev/null)" || true
  [ -z "$pids" ] && return 0
  echo "✗ port $port is already in use — refusing to kill a process we didn't start:"
  # shellcheck disable=SC2086
  ps -o pid=,command= -p $pids 2>/dev/null | sed 's/^/    /'
  echo "  stop that process (the ports 8000/8443/3101 are fixed for this runner)."
  exit 1
}
# Wait (bounded) for a Playwright-owned port to free between the spa/ssg runs.
wait_port_free() { for _ in $(seq 1 30); do lsof -ti "tcp:$1" -sTCP:LISTEN >/dev/null 2>&1 || return 0; sleep 0.1; done; return 1; }
cleanup() { kill_tree "$API_PID"; } # the app/proxy are owned by Playwright's webServer
trap cleanup INT TERM EXIT
require_port_free 8000; require_port_free 8443; require_port_free 3101

set_env() {
  local key="$1" val="$2"
  grep -q "^${key}=" "$ENV_FILE" && { grep -v "^${key}=" "$ENV_FILE" > "$ENV_FILE.tmp" && mv "$ENV_FILE.tmp" "$ENV_FILE"; }
  printf '%s=%s\n' "$key" "$val" >> "$ENV_FILE"
}

echo "▶ building the lukk API fixture in $APP_DIR ..."
LUKK_PATH="${LUKK_PATH:-}" bash "$HERE/fixture/build.sh" "$APP_DIR" || { echo "✗ fixture build failed"; exit 1; }
# Direct mode refreshes via the __Host- cookie → the API must run in cookie mode.
set_env LUKK_COOKIE_MODE true
set_env LUKK_ALGORITHM HS256
set_env LUKK_FEAT_2FA true
set_env LUKK_FEAT_PASSKEYS true
set_env LUKK_FEAT_EMAIL true
# The unified origin is https://localhost:8443, so any passkey/email flow added to the
# direct spec later resolves against it (the direct app + API share this origin).
set_env LUKK_PASSKEY_RP_ID localhost
set_env LUKK_PASSKEY_ORIGINS https://localhost:8443
set_env LUKK_VERIFY_URL https://localhost:8443/verified
( cd "$APP_DIR" && php artisan optimize:clear >/dev/null && php artisan migrate:fresh --force >/dev/null && php artisan db:seed --force >/dev/null )

echo "▶ booting the lukk API on 127.0.0.1:8000 ..."
( cd "$APP_DIR" && php artisan serve --host=127.0.0.1 --port=8000 >/tmp/lukk-direct-api.log 2>&1 ) &
API_PID=$!
up=""; for _ in $(seq 1 40); do curl -fsS http://127.0.0.1:8000/up >/dev/null 2>&1 && { up=1; break; }; sleep 0.25; done
[ -n "$up" ] || { echo "✗ API did not come up — see /tmp/lukk-direct-api.log"; exit 1; }

echo "▶ installing + building lukk-core / lukk-nuxt ..."
pnpm -C "$REPO_ROOT" install
pnpm -C "$REPO_ROOT" --filter "./packages/*" build
pnpm -C "$NUXT_APP" exec playwright install chromium

CERT_DIR="${TMPDIR:-/tmp}/lukk-e2e-tls"
mkdir -p "$CERT_DIR"
[ -f "$CERT_DIR/cert.pem" ] || openssl req -x509 -newkey rsa:2048 -nodes -keyout "$CERT_DIR/key.pem" -out "$CERT_DIR/cert.pem" -days 3 -subj "/CN=localhost" >/dev/null 2>&1
export E2E_SSL_KEY="$CERT_DIR/key.pem" E2E_SSL_CERT="$CERT_DIR/cert.pem" E2E_PORT=8443 E2E_API_PORT=8000 E2E_SPA_PORT=3101

RC=0
run_mode() {
  local mode="$1"
  echo "── DIRECT / ${mode} ─────────────────────────────────────────────"
  # Playwright tore down the previous mode's webServer; wait for its ports to free.
  wait_port_free 8443; wait_port_free 3101
  # Reset DB + cache between modes so the two runs are isolated — otherwise the second
  # mode's 2FA test can reuse a still-valid TOTP code the first mode already burned in the
  # single-use replay cache (a correct rejection, but a cross-mode false failure here).
  ( cd "$APP_DIR" && php artisan migrate:fresh --force >/dev/null && php artisan db:seed --force >/dev/null && php artisan optimize:clear >/dev/null )
  if [ "$mode" = "ssg" ]; then pnpm -C "$NUXT_APP" generate; else pnpm -C "$NUXT_APP" build; fi
  E2E_APP_MODE="$mode" pnpm -C "$NUXT_APP" exec playwright test || RC=1
}

case "$WHICH" in
  spa) run_mode spa ;;
  ssg) run_mode ssg ;;
  *)   run_mode spa; run_mode ssg ;;
esac

cleanup
exit $RC

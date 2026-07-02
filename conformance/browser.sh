#!/usr/bin/env bash
# Browser E2E: drive the lukk-nuxt BFF app in a real Chromium against a real lukk
# API — the "in field" proof for the BFF + SSR, same-origin topology.
#
# Boots the conformance fixture (the lukk API), builds lukk-core/lukk-nuxt + the
# E2E Nuxt app, and runs Playwright (which starts the app's preview server).
#
# Usage:  [LUKK_PATH=/abs/path/to/lukk] conformance/browser.sh
#
# Ports (override E2E_PORT / E2E_UPSTREAM_PORT to avoid a clash with your own apps).
# Needs: php >= 8.3, composer, node/pnpm, and Chromium (installed here on demand).
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"
APP_DIR="${LUKK_APP_DIR:-${TMPDIR:-/tmp}/lukk-bff-api}"
NUXT_APP="$REPO_ROOT/conformance/apps/nuxt-bff"
ENV_FILE="$APP_DIR/.env"
API_PID=""
APP_PORT="${E2E_PORT:-3100}"; UPSTREAM_PORT="${E2E_UPSTREAM_PORT:-3101}"

# Kill a server WE started — the pid and its descendants (artisan serve spawns a php -S
# child; killing just the shell pid would orphan it). Only ever touches our own tree.
kill_tree() {
  local pid="$1" child
  [ -n "$pid" ] || return 0
  for child in $(pgrep -P "$pid" 2>/dev/null); do kill_tree "$child"; done
  kill -9 "$pid" 2>/dev/null
}
# Abort (do NOT kill) if a port we need is already held by a foreign process — never
# force-kill a process we didn't start (it might be your own app).
require_port_free() {
  local port="$1" pids
  pids="$(lsof -ti "tcp:$port" -sTCP:LISTEN 2>/dev/null)" || true
  [ -z "$pids" ] && return 0
  echo "✗ port $port is already in use — refusing to kill a process we didn't start:"
  # shellcheck disable=SC2086
  ps -o pid=,command= -p $pids 2>/dev/null | sed 's/^/    /'
  echo "  stop it, or re-run with a free port (E2E_PORT / E2E_UPSTREAM_PORT)."
  exit 1
}
cleanup() { kill_tree "$API_PID"; } # the app/preview are owned by Playwright's webServer
trap cleanup INT TERM EXIT

require_port_free 8000; require_port_free "$APP_PORT"; require_port_free "$UPSTREAM_PORT"

set_env() {
  local key="$1" val="$2"
  grep -q "^${key}=" "$ENV_FILE" && { grep -v "^${key}=" "$ENV_FILE" > "$ENV_FILE.tmp" && mv "$ENV_FILE.tmp" "$ENV_FILE"; }
  printf '%s=%s\n' "$key" "$val" >> "$ENV_FILE"
}

echo "▶ building the lukk API fixture in $APP_DIR ..."
LUKK_PATH="${LUKK_PATH:-}" bash "$HERE/fixture/build.sh" "$APP_DIR" || { echo "✗ fixture build failed"; exit 1; }

# BFF wants the API in body mode (the Nuxt server seals the body tokens). Everything on.
set_env LUKK_COOKIE_MODE false
set_env LUKK_ALGORITHM HS256
set_env LUKK_FEAT_2FA true
set_env LUKK_FEAT_PASSKEYS true
set_env LUKK_FEAT_EMAIL true
# Browser-facing values. The E2E app runs on https://localhost:3100 (see
# playwright.config.ts), so the WebAuthn origin + the post-verify redirect are https.
set_env LUKK_PASSKEY_RP_ID localhost
set_env LUKK_PASSKEY_ORIGINS "https://localhost:$APP_PORT"
set_env LUKK_VERIFY_URL "https://localhost:$APP_PORT/verified"

( cd "$APP_DIR" && php artisan optimize:clear >/dev/null && php artisan migrate:fresh --force >/dev/null && php artisan db:seed --force >/dev/null )

echo "▶ booting the lukk API on 127.0.0.1:8000 ..."
( cd "$APP_DIR" && php artisan serve --host=127.0.0.1 --port=8000 >/tmp/lukk-bff-api.log 2>&1 ) &
API_PID=$!
up=""; for _ in $(seq 1 40); do curl -fsS http://127.0.0.1:8000/up >/dev/null 2>&1 && { up=1; break; }; sleep 0.25; done
[ -n "$up" ] || { echo "✗ API did not come up — see /tmp/lukk-bff-api.log"; exit 1; }

echo "▶ installing workspace + building lukk-core / lukk-nuxt / the E2E app ..."
pnpm -C "$REPO_ROOT" install
pnpm -C "$REPO_ROOT" --filter "./packages/*" build
pnpm -C "$NUXT_APP" exec playwright install chromium
pnpm -C "$NUXT_APP" build

# Self-signed cert so the app serves over HTTPS — the browser only persists lukk's
# Secure __Host- session cookie over a secure origin (Playwright ignores cert errors).
CERT_DIR="${TMPDIR:-/tmp}/lukk-e2e-tls"
mkdir -p "$CERT_DIR"
if [ ! -f "$CERT_DIR/cert.pem" ]; then
  openssl req -x509 -newkey rsa:2048 -nodes -keyout "$CERT_DIR/key.pem" -out "$CERT_DIR/cert.pem" \
    -days 3 -subj "/CN=localhost" >/dev/null 2>&1
fi
export E2E_SSL_KEY="$CERT_DIR/key.pem" E2E_SSL_CERT="$CERT_DIR/cert.pem" E2E_PORT="$APP_PORT" E2E_UPSTREAM_PORT="$UPSTREAM_PORT"

echo "▶ running Playwright (BFF + SSR, same-origin, HTTPS) ..."
pnpm -C "$NUXT_APP" exec playwright test
RC=$?

cleanup
exit $RC

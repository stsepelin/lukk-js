#!/usr/bin/env bash
# Browser E2E: drive the lukk-nuxt BFF app in a real Chromium against a real lukk
# API — the "in field" proof for the BFF + SSR, same-origin topology.
#
# Boots the conformance fixture (the lukk API), builds lukk-core/lukk-nuxt + the
# E2E Nuxt app, and runs Playwright (which starts the app's preview server).
#
# Usage:  [LUKK_PATH=/abs/path/to/lukk] conformance/browser.sh [--nuxt floor,3,4]
#
# `--nuxt` (or E2E_NUXT) runs the SAME specs against several Nuxt versions, one after another —
# `floor` is the declared `@nuxt/kit` floor, `3`/`4` the newest of that major, anything else a
# literal version. Each gets a prepared copy under `conformance/.matrix/` (see lib/nuxt-matrix.sh);
# the default is the app's own pin, i.e. what a plain `pnpm build` uses.
#
# Ports (override E2E_PORT / E2E_UPSTREAM_PORT to avoid a clash with your own apps).
# Needs: php >= 8.3, composer, node/pnpm, and Chromium (installed here on demand).
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"
# shellcheck source=lib/nuxt-matrix.sh
. "$HERE/lib/nuxt-matrix.sh"

NUXT_VERSIONS="${E2E_NUXT:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --nuxt) NUXT_VERSIONS="${2:-}"; shift 2 ;;
    --nuxt=*) NUXT_VERSIONS="${1#*=}"; shift ;;
    *) echo "unknown argument: $1"; exit 2 ;;
  esac
done
APP_DIR="${LUKK_APP_DIR:-${TMPDIR:-/tmp}/lukk-bff-api}"
NUXT_APP="$REPO_ROOT/conformance/apps/nuxt-bff"
ENV_FILE="$APP_DIR/.env"
API_PID=""
# Per-run private directory (mode 700). On a shared build host a predictable /tmp path lets another
# user pre-plant the TLS keypair the runner serves with, drive the fault proxy, or symlink the API log
# over one of your files — none of which anything here would notice.
RUN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/lukk-e2e.XXXXXX")"
echo "▶ run directory (TLS, fault control, API log): $RUN_DIR"

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
# `PHP_CLI_SERVER_WORKERS`: the built-in server is single-threaded, and these suites hold two
# tabs open at once — a second request while one is in flight gets its socket closed, which the
# proxy reports as "other side closed" and the test reads as a logout that never happened.
# `--no-reload` is REQUIRED with it: without the flag Laravel warns and starts a single server.
( cd "$APP_DIR" && PHP_CLI_SERVER_WORKERS=4 php artisan serve --no-reload --host=127.0.0.1 --port=8000 >"$RUN_DIR/api.log" 2>&1 ) &
API_PID=$!
up=""; for _ in $(seq 1 40); do curl -fsS http://127.0.0.1:8000/up >/dev/null 2>&1 && { up=1; break; }; sleep 0.25; done
[ -n "$up" ] || { echo "✗ API did not come up — see $RUN_DIR/api.log"; exit 1; }

echo "▶ installing workspace + building lukk-core / lukk-nuxt ..."
pnpm -C "$REPO_ROOT" install
pnpm -C "$REPO_ROOT" --filter "./packages/*" build
pnpm -C "$NUXT_APP" exec playwright install chromium

# Self-signed cert so the app serves over HTTPS — the browser only persists lukk's
# Secure __Host- session cookie over a secure origin (Playwright ignores cert errors).
CERT_DIR="$RUN_DIR/tls"
mkdir -p "$CERT_DIR"
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$CERT_DIR/key.pem" -out "$CERT_DIR/cert.pem" \
  -days 3 -subj "/CN=localhost" >/dev/null 2>&1
export E2E_SSL_KEY="$CERT_DIR/key.pem" E2E_SSL_CERT="$CERT_DIR/cert.pem" E2E_PORT="$APP_PORT" E2E_UPSTREAM_PORT="$UPSTREAM_PORT"
# The Nuxt server reaches lukk through a fault-injecting hop (see apps/nuxt-bff/e2e/serve.mjs), so a
# spec can make lukk unreachable without touching the API. Pass-through until a spec says otherwise.
FAULT_PORT="${E2E_FAULT_PORT:-8010}"
require_port_free "$FAULT_PORT"
export E2E_FAULT_PORT="$FAULT_PORT" E2E_API_PORT=8000
export E2E_FAULT_FILE="$RUN_DIR/fault.json"
export NUXT_LUKK_BASE_URL="http://127.0.0.1:$FAULT_PORT/auth" NUXT_LUKK_API_TARGET="http://127.0.0.1:$FAULT_PORT"
export LUKK_API_ROOT="http://127.0.0.1:8000"

# One run per Nuxt version (the app's own pin when none was asked for).
RC=0
SUMMARY=""
# Between versions: the suite burns single-use things (a TOTP code inside its window, the signed
# verification link), so a second run against the same database fails on the FIRST one's leftovers.
reseed() {
  ( cd "$APP_DIR" && php artisan migrate:fresh --force >/dev/null && php artisan db:seed --force >/dev/null && php artisan optimize:clear >/dev/null )
}

run_suite() {
  local dir="$1" label="$2"
  reseed
  echo "▶ building the E2E app ($label) ..."
  pnpm -C "$dir" build || { SUMMARY="$SUMMARY\n  ✗ $label (build failed)"; RC=1; return; }
  echo "▶ running Playwright (BFF + SSR, same-origin, HTTPS) — $label ..."
  if pnpm -C "$dir" exec playwright test; then
    SUMMARY="$SUMMARY\n  ✓ $label"
  else
    SUMMARY="$SUMMARY\n  ✗ $label"; RC=1
    # What the API actually answered. Without this a CI-only failure is guesswork: the proxy logs
    # "other side closed" for any dropped hop, which says nothing about lukk's own reply.
    echo "── lukk API log (last 60 lines) ──"; tail -60 "$RUN_DIR/api.log" 2>/dev/null || echo "(none)"
    for ctx in "$dir"/test-results/*/error-context.md; do
      [ -f "$ctx" ] || continue
      echo "── $(basename "$(dirname "$ctx")") ──"; head -40 "$ctx"
    done
  fi
}

if [ -z "$NUXT_VERSIONS" ]; then
  run_suite "$NUXT_APP" "nuxt $(node -e "process.stdout.write(require('$NUXT_APP/node_modules/nuxt/package.json').version)")"
else
  IFS=',' read -r -a WANTED <<< "$NUXT_VERSIONS"
  for spec in "${WANTED[@]}"; do
    version="$(resolve_nuxt_version "$REPO_ROOT" "$spec")"
    echo "▶ preparing the E2E app for nuxt@$version ..."
    dir="$(prepare_matrix_app "$REPO_ROOT" "$NUXT_APP" "$version")"
    resolved="$(install_matrix_app "$dir")" || { echo "✗ install failed for nuxt@$version"; SUMMARY="$SUMMARY\n  ✗ nuxt@$version (install failed)"; RC=1; continue; }
    run_suite "$dir" "nuxt $resolved"
  done
fi

echo ""
echo "▶ browser E2E (BFF):$(printf '%b' "$SUMMARY")"
cleanup
exit $RC

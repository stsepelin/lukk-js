#!/usr/bin/env bash
# Browser E2E for the DIRECT transport (SPA + SSG), same-origin with the lukk API.
# Runs the flows in a real Chromium for BOTH build modes:
#   spa → `nuxi build` (ssr:false), served by the Nitro preview
#   ssg → `nuxi generate`, served as static files
# The app and API share one https origin via conformance/apps/nuxt-direct/e2e/serve-direct.mjs.
#
# Usage:  [LUKK_PATH=/abs/path/to/lukk] conformance/browser-direct.sh [spa|ssg|both] [--nuxt floor,3,4]
#
# `--nuxt` (or E2E_NUXT) runs the same specs against several Nuxt versions — see lib/nuxt-matrix.sh.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"
# shellcheck source=lib/nuxt-matrix.sh
. "$HERE/lib/nuxt-matrix.sh"
APP_DIR="${LUKK_APP_DIR:-${TMPDIR:-/tmp}/lukk-direct-api}"
NUXT_APP="$REPO_ROOT/conformance/apps/nuxt-direct"
ENV_FILE="$APP_DIR/.env"
WHICH="both"
NUXT_VERSIONS="${E2E_NUXT:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    spa | ssg | both) WHICH="$1"; shift ;;
    --nuxt) NUXT_VERSIONS="${2:-}"; shift 2 ;;
    --nuxt=*) NUXT_VERSIONS="${1#*=}"; shift ;;
    *) echo "unknown argument: $1"; exit 2 ;;
  esac
done
API_PID=""
# Per-run private directory (mode 700). On a shared build host a predictable /tmp path lets another
# user pre-plant the TLS keypair the runner serves with, drive the fault proxy, or symlink the API log
# over one of your files — none of which anything here would notice.
RUN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/lukk-e2e.XXXXXX")"
echo "▶ run directory (TLS, fault control, API log): $RUN_DIR"


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
# `PHP_CLI_SERVER_WORKERS`: the built-in server is single-threaded, and these suites hold two
# tabs open at once — a second request while one is in flight gets its socket closed, which the
# proxy reports as "other side closed" and the test reads as a logout that never happened.
# `--no-reload` is REQUIRED with it: without the flag Laravel warns and starts a single server.
( cd "$APP_DIR" && PHP_CLI_SERVER_WORKERS=4 php artisan serve --no-reload --host=127.0.0.1 --port=8000 >"$RUN_DIR/api.log" 2>&1 ) &
API_PID=$!
up=""; for _ in $(seq 1 40); do curl -fsS http://127.0.0.1:8000/up >/dev/null 2>&1 && { up=1; break; }; sleep 0.25; done
[ -n "$up" ] || { echo "✗ API did not come up — see $RUN_DIR/api.log"; exit 1; }

echo "▶ installing + building lukk-core / lukk-nuxt ..."
pnpm -C "$REPO_ROOT" install
pnpm -C "$REPO_ROOT" --filter "./packages/*" build
pnpm -C "$NUXT_APP" exec playwright install chromium

CERT_DIR="$RUN_DIR/tls"
mkdir -p "$CERT_DIR"
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$CERT_DIR/key.pem" -out "$CERT_DIR/cert.pem" -days 3 -subj "/CN=localhost" >/dev/null 2>&1
export E2E_SSL_KEY="$CERT_DIR/key.pem" E2E_SSL_CERT="$CERT_DIR/cert.pem" E2E_PORT=8443 E2E_API_PORT=8000 E2E_SPA_PORT=3101
# The API shares the app's origin here (the unifying proxy routes /auth /conformance /up to it).
export LUKK_API_ROOT="https://localhost:8443"

RC=0
SUMMARY=""
APP_UNDER_TEST="$NUXT_APP"
run_mode() {
  local mode="$1" label="$2"
  echo "── DIRECT / ${mode} / ${label} ──────────────────────────────────"
  # Playwright tore down the previous mode's webServer; wait for its ports to free.
  wait_port_free 8443; wait_port_free 3101
  # Reset DB + cache between modes so the two runs are isolated — otherwise the second
  # mode's 2FA test can reuse a still-valid TOTP code the first mode already burned in the
  # single-use replay cache (a correct rejection, but a cross-mode false failure here).
  ( cd "$APP_DIR" && php artisan migrate:fresh --force >/dev/null && php artisan db:seed --force >/dev/null && php artisan optimize:clear >/dev/null )
  # A failed build is a failed mode, not a run against the PREVIOUS build's output — which is what an
  # unchecked exit code gave: stale `.output`, specs passing, the change under test never exercised.
  # One mode per base SHAPE (see the app's nuxt.config): `spa` builds against an absolute lukk base,
  # `ssg` against the relative one. Same origin either way; different paths through the credential rule.
  if [ "$mode" = "ssg" ]; then unset E2E_LUKK_BASE_URL; else export E2E_LUKK_BASE_URL="https://localhost:8443/auth"; fi
  if ! { if [ "$mode" = "ssg" ]; then pnpm -C "$APP_UNDER_TEST" generate; else pnpm -C "$APP_UNDER_TEST" build; fi }; then
    SUMMARY="$SUMMARY\n  ✗ $mode / $label (build failed)"; RC=1; return
  fi
  if E2E_APP_MODE="$mode" pnpm -C "$APP_UNDER_TEST" exec playwright test
  then SUMMARY="$SUMMARY\n  ✓ $mode / $label"
  else SUMMARY="$SUMMARY\n  ✗ $mode / $label"; RC=1
  fi
}

run_modes() {
  local label="$1"
  case "$WHICH" in
    spa) run_mode spa "$label" ;;
    ssg) run_mode ssg "$label" ;;
    *)   run_mode spa "$label"; run_mode ssg "$label" ;;
  esac
}

if [ -z "$NUXT_VERSIONS" ]; then
  run_modes "nuxt $(node -e "process.stdout.write(require('$NUXT_APP/node_modules/nuxt/package.json').version)")"
else
  IFS=',' read -r -a WANTED <<< "$NUXT_VERSIONS"
  for spec in "${WANTED[@]}"; do
    version="$(resolve_nuxt_version "$REPO_ROOT" "$spec")"
    echo "▶ preparing the direct E2E app for nuxt@$version ..."
    APP_UNDER_TEST="$(prepare_matrix_app "$REPO_ROOT" "$NUXT_APP" "$version")"
    resolved="$(install_matrix_app "$APP_UNDER_TEST")" || { echo "✗ install failed for nuxt@$version"; SUMMARY="$SUMMARY\n  ✗ nuxt@$version (install failed)"; RC=1; continue; }
    run_modes "nuxt $resolved"
  done
fi

echo ""
echo "▶ browser E2E (direct):$(printf '%b' "$SUMMARY")"
cleanup
exit $RC

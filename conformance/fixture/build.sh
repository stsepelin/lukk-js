#!/usr/bin/env bash
# Build a minimal Laravel host app with lukk installed, for conformance testing.
# Shared by the Dockerfile, the CI job, and local runs (needs php >= 8.3 + composer).
#
# Usage:  [LUKK_COOKIE_MODE=true] build.sh [APP_DIR]
set -euo pipefail

APP_DIR="${1:-$PWD/app}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COOKIE_MODE="${LUKK_COOKIE_MODE:-false}"

# Pin Laravel 12 (Symfony 7): web-auth/webauthn-lib doesn't support Symfony 8 yet,
# and lukk supports ^12|^13 — so 12 gives us the passkey feature in conformance.
if [ ! -f "$APP_DIR/artisan" ]; then
  composer create-project 'laravel/laravel:^12' "$APP_DIR" --no-interaction --prefer-dist
fi
cd "$APP_DIR"

# lukk + its (optional) 2FA and passkey libraries, so conformance covers every feature.
# -W lets the resolver adjust transitive deps (webauthn pulls older symfony/cbor).
composer require lukk/lukk pragmarx/google2fa web-auth/webauthn-lib --no-interaction --no-progress -W

# Drop any previously-published lukk migrations first — re-publishing stamps a new
# timestamp each time, so without this a rebuild accumulates duplicates (→ "duplicate column").
rm -f database/migrations/*refresh_tokens* database/migrations/*two_factor* database/migrations/*passkeys* 2>/dev/null || true

# Publish-only migrations (Sanctum/Passport convention): core + 2FA + passkeys.
php artisan vendor:publish --tag=lukk-migrations --force --no-interaction
php artisan vendor:publish --tag=lukk-two-factor-migrations --force --no-interaction
php artisan vendor:publish --tag=lukk-passkey-migrations --force --no-interaction

# Inject the host wiring: User traits, the lukk-jwt guard, a partial (deep-merged)
# lukk config that flips features on, and seeded users.
cp "$HERE/overrides/User.php"           app/Models/User.php
cp "$HERE/overrides/auth.php"           config/auth.php
cp "$HERE/overrides/lukk.php"           config/lukk.php
cp "$HERE/overrides/DatabaseSeeder.php" database/seeders/DatabaseSeeder.php
cp "$HERE/overrides/env.fixture"        .env
echo "LUKK_COOKIE_MODE=$COOKIE_MODE" >> .env

: > database/database.sqlite

# Make sure the autoloader sees the freshly-copied User + DatabaseSeeder classes.
composer dump-autoload --optimize --no-interaction

php artisan key:generate --no-interaction
# Nuke every cache (config/route/events + the file cache that holds rate-limit
# counters + the denylist) so prior runs don't leak in.
php artisan optimize:clear
php artisan migrate:fresh --force
php artisan db:seed --force

echo "✓ lukk conformance fixture ready in $APP_DIR (cookie_mode=$COOKIE_MODE)"

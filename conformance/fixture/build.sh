#!/usr/bin/env bash
# Build a minimal Laravel host app with lukk installed, for conformance testing.
# Shared by the Dockerfile, the CI job, the matrix runner, and local runs
# (needs php >= 8.3 + composer).
#
# Usage:  [LUKK_COOKIE_MODE=true] [LUKK_PATH=/abs/path/to/lukk] build.sh [APP_DIR]
#
#   LUKK_PATH  — if set, install lukk from that local path (a composer `path`
#                repository) instead of Packagist, so you test your WORKING COPY.
#                Unset → the published lukk/lukk (original CI behavior).
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

# Install lukk from the local working copy (LUKK_PATH) or Packagist. The path repo
# is symlinked, so edits to your lukk checkout are picked up on the next boot.
if [ -n "${LUKK_PATH:-}" ]; then
  echo "→ installing lukk from local path: $LUKK_PATH"
  composer config repositories.lukk path "$LUKK_PATH" --no-interaction
  LUKK_REQUIRE='lukk/lukk:@dev'
else
  LUKK_REQUIRE='lukk/lukk'
fi

# lukk + its (optional) 2FA and passkey libraries, so conformance covers every feature.
# -W lets the resolver adjust transitive deps (webauthn pulls older symfony/cbor).
composer require "$LUKK_REQUIRE" pragmarx/google2fa web-auth/webauthn-lib --no-interaction --no-progress -W

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

# Pre-generate BOTH an RSA (RS256) and an EC (ES256) keypair so the matrix runner
# can switch the signing algorithm by editing .env alone — no keygen per combo.
# HS256 is the default (LUKK_SECRET); these are only consulted when LUKK_ALGORITHM
# is set to RS256/ES256 (which also points LUKK_PRIVATE_KEY/PUBLIC_KEY at them).
php -r '
  $rsa = openssl_pkey_new(["private_key_bits" => 2048, "private_key_type" => OPENSSL_KEYTYPE_RSA]);
  openssl_pkey_export($rsa, $rp);
  file_put_contents("storage/lukk_rsa_private.pem", $rp);
  file_put_contents("storage/lukk_rsa_public.pem", openssl_pkey_get_details($rsa)["key"]);
  $ec = openssl_pkey_new(["private_key_type" => OPENSSL_KEYTYPE_EC, "curve_name" => "prime256v1"]);
  openssl_pkey_export($ec, $ep);
  file_put_contents("storage/lukk_ec_private.pem", $ep);
  file_put_contents("storage/lukk_ec_public.pem", openssl_pkey_get_details($ec)["key"]);
'

# Test-only helper routes for the E2E flows (email verification needs the signed
# link out-of-band; JWKS/verified state needs a peek at the DB). Gated to non-prod.
# Appended to the stock web routes (throwaway fixture; the Route facade is aliased).
# Idempotent: a rebuild over an existing app dir must not append the block twice.
if ! grep -q '/conformance/last-verification-url' routes/web.php; then
cat >> routes/web.php <<'PHP'

// The app's own authenticated user endpoint (lukk issues the token; the app owns
// the user resource). Reached in BFF mode via the same-origin app-API proxy at
// /api/user, and in direct mode as /user with a Bearer. Extends lukk's UserResource
// (id + derived email_verified) with the app's own `email` field via fields() — the
// realistic pattern — and returns { "data": {...} }, which the client auto-unwraps.
Route::get('/user', fn (\Illuminate\Http\Request $request) => new class ($request->user()) extends \Lukk\Http\Resources\UserResource {
    protected function fields(\Illuminate\Http\Request $request): array
    {
        return ['email' => $this->resource->email];
    }
})->middleware('auth:api');

// --- conformance helpers (test-only; see conformance/README.md) ---
if (app()->environment() !== 'production') {
    Route::get('/conformance/last-verification-url', function () {
        $log = storage_path('logs/laravel.log');
        $body = is_file($log) ? (string) file_get_contents($log) : '';
        preg_match_all('#https?://[^\s"\'<>\\\\)]+/auth/email/verify/[^\s"\'<>\\\\)]+#', $body, $m);
        $url = end($m[0]) ?: null;
        // Logged messages escape "&" as-is but may HTML-encode it; normalise for a clickable link.
        return response()->json(['url' => $url ? str_replace('&amp;', '&', $url) : null]);
    });

    Route::get('/conformance/user-verified', function (\Illuminate\Http\Request $request) {
        $user = \App\Models\User::where('email', (string) $request->query('email'))->first();
        return response()->json(['verified' => $user ? $user->hasVerifiedEmail() : null]);
    });
}
PHP
fi

: > database/database.sqlite

# Make sure the autoloader sees the freshly-copied User + DatabaseSeeder classes.
composer dump-autoload --optimize --no-interaction

php artisan key:generate --no-interaction
# Nuke every cache (config/route/events + the file cache that holds rate-limit
# counters + the denylist) so prior runs don't leak in.
php artisan optimize:clear
php artisan migrate:fresh --force
php artisan db:seed --force

echo "✓ lukk conformance fixture ready in $APP_DIR (cookie_mode=$COOKIE_MODE, lukk=${LUKK_PATH:-packagist})"

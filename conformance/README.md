# Conformance harness

The JS clients are validated against a **real lukk instance**, not hand-written
fixtures — that's what keeps the TypeScript contract from drifting from the PHP
source. CI runs this on every push (`.github/workflows/conformance.yml`), across
both delivery modes.

Flows are run end-to-end, not just shape-checked: password login, refresh
rotation, logout revocation, step-up confirmation, a **completed 2FA challenge**
(a real TOTP), and a **full passkey register → passwordless login** ceremony.
The TOTP generator and the software WebAuthn authenticator are built on
`node:crypto` (see `packages/core/conformance/authenticator.ts`) — no extra deps.

## Run it locally

With Docker:

```bash
docker compose -f conformance/docker-compose.yml up -d --build   # boot real lukk on :8000
pnpm --filter lukk-core test:conformance                         # run client flows against it
docker compose -f conformance/docker-compose.yml down
```

Or natively (needs PHP ≥ 8.3 + Composer):

```bash
bash conformance/fixture/build.sh /tmp/lukk-fixture              # generate the Laravel app
(cd /tmp/lukk-fixture && php artisan serve --port=8000 &)
LUKK_URL=http://127.0.0.1:8000/auth pnpm --filter lukk-core test:conformance
```

### Both delivery modes

`LUKK_COOKIE_MODE` toggles BFF/body mode (`false`, default) vs direct/cookie mode
(`true`) — pass it to **both** the build and the test run:

```bash
LUKK_COOKIE_MODE=true docker compose -f conformance/docker-compose.yml up -d --build
LUKK_COOKIE_MODE=true pnpm --filter lukk-core test:conformance
```

## The full matrix (`matrix.sh`)

[`matrix.sh`](./matrix.sh) boots one real lukk instance and runs the client flows
against it in **every combination** — proving the whole surface works in the field,
not just one config. It builds the fixture once, then per combo rewrites `.env`,
resets the DB, restarts `php artisan serve`, and runs the (feature-gated) suite:

```bash
# Test the PUBLISHED lukk (default), or your local working copy with LUKK_PATH:
LUKK_PATH=/abs/path/to/lukk conformance/matrix.sh
```

Axes covered:

- **Features** — the 7 combos from `none` → `2fa + passkeys + email`. The suite
  skips the flows a combo doesn't enable (`LUKK_FEAT_2FA` / `_PASSKEYS` / `_EMAIL`),
  so e.g. the passkey ceremony only runs when passkeys are on.
- **Signing algorithm** — `HS256` (default), `RS256`, `ES256` (`LUKK_ALGORITHM`).
  `build.sh` pre-generates an RSA and an EC keypair so switching is an `.env` edit.
  Under an asymmetric algorithm the suite also fetches `/auth/jwks` and
  **independently verifies** an issued access token from the public JWK set alone
  (the "separate resource server" topology) — and confirms a tampered token fails.
- **Delivery** — BFF/body vs direct/cookie (`LUKK_COOKIE_MODE`).

`LUKK_PATH` (a Composer `path` repo) is how you validate an *unreleased* lukk change
end-to-end before publishing. Email verification is exercised for real: the `log`
mailer writes the signed link, a test-only `/conformance/last-verification-url` route
(gated to non-production) hands it back, and the flow clicks it and asserts the flip.

## Browser E2E (`browser.sh`)

The matrix above drives the JS client at the HTTP level. [`browser.sh`](./browser.sh)
goes one layer further — a **real Chromium** driving the `lukk-nuxt` **BFF app in SSR
mode** against a real lukk API, proving the delivery topology end-to-end (guards, the
sealed server-side session, SSR hydration, the token-stripping proxy):

```bash
LUKK_PATH=/abs/path/to/lukk conformance/browser.sh
```

The app under test is [`apps/nuxt-bff/`](./apps/nuxt-bff) (committed): `lukk-nuxt` in
`mode: 'bff'`, `ssrHydrate: true`, with `/api/**` proxied to the lukk API. The suite
([`e2e/bff-ssr.spec.ts`](./apps/nuxt-bff/e2e/bff-ssr.spec.ts)) covers the auth-guard
redirect, password login, **SSR hydration** (the server-rendered HTML already contains
the user — asserted against the raw response), session persistence across a full reload,
logout re-locking, and a **2FA challenge completed with a live TOTP**.

Notes:
- Served over **HTTPS** (self-signed cert, `Playwright ignoreHTTPSErrors`) via a tiny
  proxy in front of the Nitro preview ([`e2e/serve.mjs`](./apps/nuxt-bff/e2e/serve.mjs)) —
  the browser only persists lukk's `Secure __Host-` session cookie over a secure origin.
- Runs on **:3100** (dodging common `:3000` squatters); the API on **:8000**. The runner
  frees those ports by PID first (a lingering `php -S` from `artisan serve` won't be caught
  by a command-name `pkill`).
- Set `E2E_DEBUG=1` to log the browser console + every `/api/*` response for triage.

### Direct mode — SPA + SSG (`browser-direct.sh`)

[`browser-direct.sh`](./browser-direct.sh) drives the `lukk-nuxt` **direct** transport
(no BFF proxy — the client holds the access token in memory, refresh rides the `__Host-`
cookie) in a real browser, for **both** build modes:

```bash
LUKK_PATH=/abs/path/to/lukk conformance/browser-direct.sh   # runs spa then ssg (or pass `spa`/`ssg`)
```

The app is [`apps/nuxt-direct/`](./apps/nuxt-direct) (`ssr: false`); **SPA** = `nuxi build`
(served by the Nitro preview), **SSG** = `nuxi generate` (served as static files). The suite
([`e2e/direct.spec.ts`](./apps/nuxt-direct/e2e/direct.spec.ts)) covers the client guard
redirect, password login, **session restore on reload via the refresh cookie**, logout, and
a 2FA challenge — identical flows in both modes.

**Same-origin is required — and why.** lukk-core deliberately attaches the bearer / cookie
**only to a same-origin `baseURL`** (`packages/core/src/client.ts` `isSameOrigin`) — an
anti-leak invariant. So the harness puts the SPA/SSG **and** the lukk API under **one https
origin** via a path-routing proxy ([`e2e/serve-direct.mjs`](./apps/nuxt-direct/e2e/serve-direct.mjs):
`/auth /user /jwks /conformance /up` → the API, everything else → the app). https is required
so the browser persists the Secure `__Host-` cookie.

### Cross-origin / different domains → use the BFF

A truly cross-**site** app (a different registrable domain than the API) can't use direct
mode for silent refresh: the `__Host-` refresh cookie is `SameSite=Strict` (not sent
cross-site) and lukk-core won't attach a bearer to a cross-origin `baseURL`. That's by
design — **cross-origin/different-domain deployments use the BFF** (validated above), which
keeps tokens server-side and exposes only a same-origin proxy to the browser. Cross-*origin*
but same-*site* (e.g. different ports on `localhost`, or `app.example.com` ↔ `api.example.com`)
works through the BFF's same-origin proxy; the direct harness exercises the same-origin case.

This is the flagship + direct transports. The topology matrix: **BFF+SSR** (same-origin,
`browser.sh`) and **direct SPA/SSG** (same-origin, `browser-direct.sh`); cross-domain is the
BFF's job.

## What's in `fixture/`

A minimal Laravel host app, generated by [`build.sh`](./fixture/build.sh):

- `composer require lukk/lukk pragmarx/google2fa web-auth/webauthn-lib` (pinned to
  Laravel 12 — webauthn-lib doesn't support Symfony 8 yet; lukk supports `^12|^13`).
- Publishes all three migration groups (`lukk-migrations`, `-two-factor-`, `-passkey-`).
- `overrides/` injects the host wiring: the `User` model (`HasRefreshTokens` +
  `HasTwoFactorAuthentication`, implementing `MustVerifyEmail`), the `lukk-jwt` guard
  (`auth.php`), a partial (deep-merged) `lukk.php` whose features **and signing
  algorithm are env-driven** (so `matrix.sh` can flip them), and a seeder.
- Seeds `user@example.com` (plain, verified), `2fa@example.com` (confirmed 2FA), and
  `unverified@example.com` (drives the email-verification flow) — all password
  `password`. Throttling is relaxed so the suite can replay flows.
- `build.sh` also pre-generates RSA + EC keypairs (for the RS256/ES256 axis) and
  appends test-only helper routes (`/conformance/last-verification-url`,
  `/conformance/user-verified`), gated to non-production.

Compatibility is tracked as a matrix (lukk version ⇄ lukk-js version) in the root README.

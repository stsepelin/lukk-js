# lukk-nuxt

## 0.2.1

### Patch Changes

- f106eca: The BFF app-API proxy now sets `Accept: application/json` on forwarded requests by default (`api.forceJson`, default `true`).

  This fixes the "confusing 500" on unauthenticated/validation errors. The proxy strips the browser's `Accept` (h3 behaviour), so without this Laravel's default `redirectGuestsTo(fn () => route('login'))` makes `Authenticate` eagerly resolve `route('login')` _inside the middleware_ → `RouteNotFoundException` (a 500) — which `shouldRenderJsonWhen` can't prevent (it runs after the middleware already threw). Forcing JSON makes `expectsJson()` true, so unauthenticated/validation failures render clean `401`/`422` JSON with **no `bootstrap/app.php` change**.

  Opt out with `api: { forceJson: false }` to forward the browser's `Accept` instead — only if a route under `path` legitimately serves a non-JSON response.

## 0.2.0

### Minor Changes

- 61f8e2b: Add a BFF app-API proxy and a read-only server session helper.

  - `lukk: { api: { path, target } }` — proxy your own Laravel API in BFF mode, injecting the access token server-side (SSRF-safe fixed target, CSRF-checked, spoofable `X-Forwarded-*` stripped, no token in the browser).
  - `getLukkAccessToken(event)` / `useLukkSession(event)` — read the access token in your own Nitro routes without any `Set-Cookie` side effect.
  - Exported `LUKK_BFF_PREFIX` and `LUKK_SESSION_COOKIE` constants.

  **Breaking (BFF mode):** the sealed session cookie is now `__Host-lukk-session` (was `lukk-session`), to enforce the `__Host-` prefix hardening (Secure, Path=/, no Domain). BFF sessions created on 0.1.x are invalidated on upgrade — affected users simply sign in again once. Requires HTTPS in production (localhost is exempt in dev).

## 0.1.0

### Minor Changes

- Initial release — first-party JS/TS clients for lukk: framework-agnostic `lukk-core` (contract types, auth client, WebAuthn helpers) and the `lukk-nuxt` module (BFF + direct modes, auth, 2FA, step-up confirmation, passkeys).

### Patch Changes

- Updated dependencies
  - lukk-core@0.1.0

# lukk-core

## 0.10.1

No changes to `lukk-core`. It versions in lockstep with `lukk-nuxt`, which shipped a fix for a proxy outage in 0.10.0 — see its changelog.

## 0.10.0

### Minor Changes

- 9b1f15d: Add `changePassword` and `useLukkChangePassword` for lukk's new `POST /auth/password`.

  The signed-in counterpart to the reset flow: no emailed token, because `current_password` is the proof. That's the point of the endpoint — a stolen access token alone must not be enough to take an account over permanently, which is exactly what changing the password would do.

  ```ts
  const { changePassword, changing } = useLukkChangePassword();

  await changePassword({
    current_password: current.value,
    password: next.value,
    password_confirmation: confirm.value,
  });
  ```

  lukk revokes every **other** session on success and keeps the current one, so there is no token to swap and nothing to re-login — the composables' state is already correct afterwards. A wrong current password is a `422` on `current_password`, which [`useLukkForm`](https://stsepelin.github.io/lukk-docs/use-lukk-form) maps onto your fields; the endpoint shares lukk's step-up throttle, so a burst of wrong guesses is a `429` and, where the account lockout is enabled, eventually a `423`.

  A change made while one is already in flight is refused **without a request**. The second would carry a `current_password` the first has already replaced, so lukk reads it as a wrong password and spends one of the account's consecutive-failure attempts — a double-submit would quietly eat the user's lockout budget and report a `422` for a change that had just succeeded.

### Patch Changes

- 6d1d476: Fixes from a full white-box security audit (three parallel passes: BFF server, `lukk-core`, Nuxt module/SSR). No Critical or High.

  **`isSameOrigin` was bypassable.** The guard tested `^https?://`, which is far stricter than WHATWG URL parsing — the parser strips leading C0 controls and spaces and treats `\` as `/` for special schemes. So `https:/\evil.com`, `​ https://evil.com` (leading space) and tab-prefixed variants all read as "relative" and were green-lit for credentials, while resolving to `evil.com`. On SSR that meant the sealed `__Host-lukk-session` cookie, not just the bearer. The guard now canonicalises before deciding, and refuses any protocol-relative or non-http scheme. `joinURL` also stripped only one leading slash, so an empty base could itself emit a protocol-relative URL.

  **A proxied `/refresh` burned a rotation and still failed.** The browser holds an opaque cookie, not a refresh token, so `restore()`'s empty body asked lukk to rotate nothing → 401 → the proxy's generic 401 branch rotated the _sealed_ token and retried the same empty body. `restore()` could never succeed in BFF mode, and two tabs reloading concurrently would replay a consumed token past the grace window — the false family revoke this package exists to avoid. `/refresh` is now served from the sealed session and never proxied.

  **The auth proxy emitted no cache directives.** It returns a body and drops the upstream's headers, discarding lukk's `Cache-Control: no-store` with nothing to replace it — so authenticated GETs (the passkey inventory, the recovery-code count) could reach a shared cache with no directives and no `Vary`, keyed on path alone. Now `private, no-store` + `vary: cookie`, matching the app-API proxy.

  **The credential strip now fails closed.** It only ran when the body matched `isTokenPair`, so a near-miss like `{"access_token": null, "refresh_token": "…"}` passed a rotating refresh token through to the browser. Capture still requires the shape; removal no longer does.

  Also: the app-API proxy's 3xx branch no longer returns before stripping `Set-Cookie` and setting `no-store` (harmless on Node, live on workerd/Deno); h3's alternate `x-<name>-session` header channel is disabled on every session and blanked upstream; the CSRF check compares the scheme and honours `Sec-Fetch-Site`; a short `session.password` and an invalid or cross-origin `user.endpoint` now fail the build instead of surfacing in production; the direct-mode client routes its confirmation header through the same runtime fallback the proxies use; `challenge_token`/`confirmation_token` state writes are client-only like the access token; a redirect is only followed when it stays on the API's origin, and a caller can no longer re-enable redirect following; the refresh path validates the token shape before handing it to `onTokens`; and a `__proto__` field in a validation bag is ignored.

- b2ce100: Harden the app-API proxy's header handling (RFC 9110 §7.6).

  **Hop-by-hop headers.** h3's `proxyRequest` drops `connection`, `keep-alive`, `upgrade` and `transfer-encoding`, but not the rest of the standard set — `te`, `trailer`, `proxy-connection`, `proxy-authenticate` and `proxy-authorization` were forwarded upstream, the last of which is credential material scoped to a single hop.

  More importantly it drops the `Connection` header itself while still forwarding **the fields that header named**. §7.6.1 requires a proxy to parse `Connection` and remove the fields it lists, so a header the client explicitly marked single-hop was reaching the upstream with the instruction to strip it gone. Those fields are now blanked — except the ones the proxy sets itself, so a client cannot use `Connection` to strip the injected `Authorization` or step-up token on the way through.

  **Vendor client-IP headers.** The blanked list covered ten headers and missed a good many: `x-forwarded-server`, `x-original-forwarded-for`, `client-ip`, `x-originating-ip`, Cloudflare's `cf-connecting-ipv6`/`cf-pseudo-ipv4`, Azure's `x-azure-clientip`/`x-azure-socketip`, `fly-client-ip`, `x-vercel-forwarded-for`, `x-appengine-user-ip`, `do-connecting-ip` and others. Any of these arriving from the browser is an attempt to choose the upstream's idea of `$request->ip()` — the value lukk keys rate limits and the account lockout on.

  **Via.** Both proxies now identify themselves per §7.6.3, using a pseudonym rather than the BFF's internal hostname, and appending to an existing chain rather than replacing it. Request direction only: sending `Via` back to the browser would advertise the proxy and its version for no benefit the browser can use.

  The auth proxy was already sound here — it builds its request headers from scratch rather than forwarding the client's, so nothing spoofable could reach lukk through it. Only `Via` was owed.

## 0.9.0

## 0.8.0

## 0.7.1

## 0.7.0

### Minor Changes

- d07f6eb: Add registration (pairs with lukk's `features.registration`). `lukk-core` gains a `register(input)` client method plus `RegisterInput` / `RegisterResult` / `RegistrationPending` types and an `isRegistrationPending` guard. `lukk-nuxt`'s `useLukkAuth` gains `register()`, which mints a session exactly like `login()` — handling the same 2FA-challenge outcome and the verify-first (`block_unverified_login`) no-session response.

## 0.6.0

### Minor Changes

- 1336362: Add password reset (pairs with lukk's `features.password_reset`). `lukk-core` gains `forgotPassword(email)` and `resetPassword(input)` client methods plus a `ResetPasswordInput` type; `lukk-nuxt` gains the auto-imported `useLukkPasswordReset` composable (`sendResetLink`, `reset`, and `sending`/`resetting` flags). Both endpoints are public and route through the configured transport (BFF proxy or direct).

## 0.5.0

### Minor Changes

- 109ada1: Accept any reasonable `user.endpoint` shape — especially Laravel's default `{ "data": {...} }` API-Resource wrapper, which previously made `useLukkAuth().user` a `{ data }` object (so `loggedIn` was `true` but every field was `undefined`).

  - **lukk-core:** new augmentable `LukkUser` interface (extend it via `declare module 'lukk-core'` to type `useLukkAuth().user` everywhere), plus `shapeUser()` and `isEmailVerified()`.
  - **lukk-nuxt:** `fetchUser` now **auto-unwraps** a clean `{ data: {...} }` wrapper (never a `meta`/`links`/`errors` envelope, and `{ data: null }` → logged-out), configurable via `user.key` (default `'data'`; `false` disables). `useLukkAuth().user` is typed `LukkUser | null`, and `verified` accepts Laravel's `email_verified_at` **or** the OIDC boolean `email_verified`. A dev-only `console.warn` fires when a "logged-in" user still looks like an un-unwrapped wrapper (no `id`), pointing at `user.key` / `$wrap = null`.

  Pairs with a new optional `Lukk\Http\Resources\UserResource` base class on the PHP side.

## 0.3.0

### Minor Changes

- ed90bec: Email verification client (pairs with lukk's opt-in `features.email_verification`). Adds `client.sendEmailVerification()` (lukk-core) and a `useLukkEmailVerification()` composable (lukk-nuxt) exposing `verified` (computed off the loaded user's `email_verified_at`), `sending`, `sendVerificationEmail()` (resend the link), and `syncAfterVerify()` (reload the user on your verify callback page). The verify link itself is a browser navigation from the email that redirects back to your SPA — the composable owns the resend + the post-redirect sync, not the verification click.

## 0.2.0

### Minor Changes

- bd63800: `login()` and `twoFactorChallenge()` now accept **extra fields**.

  `email`/`password` (and the 2FA challenge fields) stay required, but you can pass additional fields — `remember`, a captcha token, a tenant id — without a `TS` cast, and they're sent to Laravel as-is:

  ```ts
  await login({ email, password, remember: true, captcha });
  ```

  The input types are widened to `LoginInput = LoginCredentials & Record<string, unknown>` (and `TwoFactorInput` for the challenge), exposed from `lukk-core`. lukk ignores unknown fields on the default login path; to act on them (or accept a different credential field like `username`), take over login on the server with `Lukk::authenticateUsing`. Purely additive and non-breaking — existing `login({ email, password })` calls are unaffected.

### Patch Changes

- e92f1da: Export `isSameOrigin(base, path)` (the same-origin credential guard) and `lukkError(status, statusText, body)` (the Laravel-error `{ message, status, errors }` builder) so lukk-nuxt's `useLukkFetch` reuses the exact same logic instead of duplicating it — keeping the security-critical same-origin check and the error shape identical across both transports.
- ba62516: Security hardening (pre-publish review).

  - **lukk-core:** the client now sends `redirect: 'manual'` and surfaces a 3xx as an error instead of following it. On a server/undici fetch (SSR/`direct` mode, or any raw `lukk-core` consumer) a cross-origin redirect would otherwise forward the custom `X-Lukk-Confirmation` step-up header to the target (the `Authorization` bearer is stripped by the platform, custom headers are not).
  - **lukk-nuxt (BFF proxy):** `bff.ts` now reads the sealed session **read-only first** and only opens the read-write session when a request actually stores or clears tokens — so an anonymous, failed-login, or tampered/expired-seal request no longer mints an empty `__Host-lukk-session` cookie (aligning `bff.ts` with the app-API proxy).
  - **lukk-nuxt (BFF proxy):** the proxy now `console.warn`s when the sealed `__Host-lukk-session` cookie nears the 4096-octet browser limit (RFC 6265bis §5.6) — above which the browser silently drops it and every request becomes anonymous. A bloated access token (many `Lukk::tokenClaimsUsing` claims) is the usual cause; see the sealed-session claims budget in the transport-modes docs.
  - **lukk-nuxt (`useLukkForm`):** `isDirty` now serializes the baseline once (cached) instead of re-stringifying both sides on every keystroke.
  - **lukk-core:** the origin-scoped `credentials` mode is now applied _after_ the caller's `init`, so a caller can't override it (consistent with `redirect`).

## 0.1.0

### Minor Changes

- Initial release — first-party JS/TS clients for lukk: framework-agnostic `lukk-core` (contract types, auth client, WebAuthn helpers) and the `lukk-nuxt` module (BFF + direct modes, auth, 2FA, step-up confirmation, passkeys).

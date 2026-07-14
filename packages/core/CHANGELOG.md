# lukk-core

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

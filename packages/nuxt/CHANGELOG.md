# lukk-nuxt

## 0.3.0

### Minor Changes

- 46aed0e: Add `api.forwardSetCookie` — an opt-in allow-list for passing app-API cookies through the BFF proxy.

  By default the app-API proxy owns cookies: it strips **every** upstream `Set-Cookie` and re-emits only lukk's sealed session. For a hybrid app whose Laravel API legitimately sets a browser cookie, list the cookie **names** to let just those through:

  ```ts
  lukk: { mode: 'bff', api: { path: '/api', target: '…', forwardSetCookie: ['locale', 'theme'] } }
  ```

  Everything not on the list is still stripped. The sealed session cookie is **never** forwardable — even if you list its name, an upstream can't overwrite it. Default `[]` (current behavior; non-breaking).

- cc1b512: `useLukkForm` gains `form.nestedErrors` and a `rememberKey` option.

  - **`form.nestedErrors`** — the `422` errors with Laravel's dotted keys (`address.street`, `items.0.name`) expanded into a nested object, so a nested `form.data` can bind `form.nestedErrors.address?.street`. `form.errors` stays the flat, dotted-keyed map.
  - **`rememberKey`** — `useLukkForm(initial, { rememberKey: 'signup' })` backs `data` with Nuxt `useState`, so a half-filled form survives SPA navigation and back. The reset/`isDirty` baseline isn't remembered; `isDirty` compares the restored data against the original `initial`.

  Both additive and opt-in; no change to existing forms.

### Patch Changes

- 8d8c769: The BFF app-API proxy now transparently refreshes an expired session before forwarding.

  Previously the app-API proxy (`api: { path, target }`) only injected whatever access token was sealed in the session — if it had lapsed since the last auth call, the request hit your Laravel API with a stale bearer and got a `401`, even though the session was still valid and refreshable.

  Now the proxy decodes the injected access token and, if it has already expired **and** the session carries a refresh token, rotates it server-side _before_ proxying. Key properties:

  - **Shared single-flight.** The refresh reuses the same per-session single-flight as the `/api/_lukk/**` auth proxy, so a concurrent auth call and app-API call collapse to **one** `/refresh` — the rotating refresh token is never replayed (which reuse detection would punish with a full-family revoke).
  - **Streaming preserved.** The body is still streamed (`streamRequest`), never buffered — uploads keep working. Refresh happens up-front on the token, not as a 401-retry that would require re-sending the body.
  - **Revocation still surfaces.** A genuinely revoked session fails the refresh and Laravel returns its own `401` against the stale bearer — no false success.
  - **Rotated cookie carried through.** The re-sealed session cookie survives the streamed proxy response; unauthenticated calls still never open (or set) a session cookie.

- bd63800: `login()` and `twoFactorChallenge()` now accept **extra fields**.

  `email`/`password` (and the 2FA challenge fields) stay required, but you can pass additional fields — `remember`, a captcha token, a tenant id — without a `TS` cast, and they're sent to Laravel as-is:

  ```ts
  await login({ email, password, remember: true, captcha });
  ```

  The input types are widened to `LoginInput = LoginCredentials & Record<string, unknown>` (and `TwoFactorInput` for the challenge), exposed from `lukk-core`. lukk ignores unknown fields on the default login path; to act on them (or accept a different credential field like `username`), take over login on the server with `Lukk::authenticateUsing`. Purely additive and non-breaking — existing `login({ email, password })` calls are unaffected.

- ba62516: Security hardening (pre-publish review).

  - **lukk-core:** the client now sends `redirect: 'manual'` and surfaces a 3xx as an error instead of following it. On a server/undici fetch (SSR/`direct` mode, or any raw `lukk-core` consumer) a cross-origin redirect would otherwise forward the custom `X-Lukk-Confirmation` step-up header to the target (the `Authorization` bearer is stripped by the platform, custom headers are not).
  - **lukk-nuxt (BFF proxy):** `bff.ts` now reads the sealed session **read-only first** and only opens the read-write session when a request actually stores or clears tokens — so an anonymous, failed-login, or tampered/expired-seal request no longer mints an empty `__Host-lukk-session` cookie (aligning `bff.ts` with the app-API proxy).
  - **lukk-nuxt (BFF proxy):** the proxy now `console.warn`s when the sealed `__Host-lukk-session` cookie nears the 4096-octet browser limit (RFC 6265bis §5.6) — above which the browser silently drops it and every request becomes anonymous. A bloated access token (many `Lukk::tokenClaimsUsing` claims) is the usual cause; see the sealed-session claims budget in the transport-modes docs.
  - **lukk-nuxt (`useLukkForm`):** `isDirty` now serializes the baseline once (cached) instead of re-stringifying both sides on every keystroke.
  - **lukk-core:** the origin-scoped `credentials` mode is now applied _after_ the caller's `init`, so a caller can't override it (consistent with `redirect`).

- 5b1b6d9: Fix `useLukkFetch` in SSR, plus two related correctness fixes.

  - **`useLukkFetch` now works during SSR in BFF mode.** Its base is the relative proxy mount (`/api`), which a plain `ofetch` cannot fetch server-side (Node's `fetch` needs an absolute URL → "Failed to parse URL"). On the server in BFF mode, calls now route through Nuxt's request-aware fetch (`useRequestFetch`), which resolves the relative URL **in-process** and forwards the session cookie to our own proxy — with no `Host`-derived absolute URL (so no SSRF) and no network egress. The auth-aware options (JSON, `redirect: 'manual'`, same-origin guard, typed `LukkError`, single-flight refresh) are shared between this path and the client/direct ofetch instance.
  - **`useLukkAuth().fetchUser()`** loads the current user through `useLukkFetch` (SSR-authenticated) instead of a bare `$fetch`, which forwarded no cookie server-side and produced a silent 401 / logged-out flash.
  - The Nuxt module now **warns at build** when the app-API proxy is half-configured — `api.path` set without `api.target` (or vice versa); it's only registered when both are present.

- 38e5d10: Add `useLukkFetch()` — an auth-aware fetch for your **own** app API, in every context and both transport modes.

  Plain `$fetch('/api/...')` in an SSR/server context forwards no cookie, so it silently 401s against an authenticated API. `useLukkFetch()` is transport-aware and gets this right:

  - **BFF**: same-origin to the proxy mount; on SSR it forwards **only** the sealed session cookie (never `authorization`/`x-forwarded-*`), and the proxy injects the bearer.
  - **direct**: attaches the in-memory bearer and single-flights a 401 refresh-and-retry — sharing `$lukk`'s one refresh, so the rotating token is never replayed (which reuse detection would punish with a family revoke).

  It always sends `Accept: application/json`, uses `redirect: 'manual'` (an upstream 3xx becomes an external navigation rather than being silently followed), and rejects with a typed `LukkError` (`{ message, status, errors }`) so a Laravel 422 bag is ergonomic. Pair it with `getLukkAccessToken(event)` in a server route.

  Credentials are attached **only** to a same-origin-as-baseURL target — a cross-origin URL passed to `useLukkFetch` gets no cookie/bearer and `credentials: 'same-origin'` (mirrors lukk-core's guard). The boot session-restore now goes through the same single-flight, so it can't race a concurrent app-API 401 refresh.

  Additive and opt-in; the module also exposes `$lukkRefresh` (the shared single-flight refresh) on the Nuxt app.

- 05d8a34: Add `useLukkForm()` — a reactive form bound to your app API, closely modelled on Inertia's `useForm`.

  `useLukkFetch` already rejects with a typed `LukkError` (`{ status, message, errors }`); `useLukkForm` turns that into a form: hold the fields, submit them, and map a Laravel `422` bag onto per-field errors — over the same transport-aware fetch, so it's SSR-correct and identical in BFF and direct mode.

  ```ts
  const form = useLukkForm({ email: "", password: "" });
  await form.post("/register"); // form.data is the body
  form.errors.email; // ← first 422 message for `email`, if any
  form.processing; // ← reactive in-flight flag
  ```

  - Fields live under `form.data.*` (not spread onto the form), so a field may safely be named `errors`, `processing`, or `submit`. Each call returns an independent form.
  - **Reactive state:** `errors` (first message per field), `hasErrors`, `processing`, `wasSuccessful`, `recentlySuccessful` (transient "Saved!" flag, duration configurable), and `isDirty`.
  - **Verbs:** `post`/`put`/`patch`/`delete`/`get` (get sends fields as the query string), plus the generic `submit(method, url, options?)`. `options` are per-submit `ofetch` overrides plus `onSuccess`/`onError`/`onFinish` lifecycle hooks.
  - Each submit clears errors first, re-populates them only from a `422`, always resets `processing`, fires the hooks, and rethrows the `LukkError`; on success it returns the parsed body and re-baselines the defaults (so `isDirty` clears).
  - **Mutators (all chainable):** `setError`, `clearErrors(...fields)` (all when bare), `reset(...fields)` / `resetAndClearErrors(...fields)` (from an independent deep copy), `defaults(…)` (re-baseline `reset`/`isDirty`), and `transform(data => payload)` (map the fields sent on each submit).
  - **File uploads are automatic:** a `File`/`Blob` anywhere in `data` sends the submit as `multipart/form-data` with Laravel-style bracket keys (`meta[views]`, `tags[0]`); force it with `forceFormData: true`. `form.cancel()` aborts the in-flight submit.

  Additive and opt-in; auto-imported like the other `useLukk*` composables. Exposes the `LukkForm<T>` type.

- Updated dependencies [e92f1da]
- Updated dependencies [bd63800]
- Updated dependencies [ba62516]
  - lukk-core@0.2.0

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

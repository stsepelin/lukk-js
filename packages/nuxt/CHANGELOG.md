# lukk-nuxt

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

- c108190: Add `clientIpHeader`, an opt-in trusted-proxy setting that lets the upstream identify the real visitor.

  Both proxies previously identified the caller by the **socket address** (`getRequestIP(event, { xForwardedFor: false })`). Behind any reverse proxy — nginx, Cloudflare, a load balancer — that address is the _proxy_, not the visitor, so an upstream keying on `$request->ip()` sees every visitor as one identity. Laravel's `throttle:5,1` on a public form then means **5 requests per minute globally**, not per client: one user can lock out everyone else. It's invisible until someone trips it, and no upstream configuration can fix it, because the information never reaches the request.

  Blanking the spoofable headers is still right by default — otherwise any client could claim any IP and defeat upstream rate limiting or IP allowlists. What was missing was a way to say _"this hop is trusted"_ when it genuinely is:

  ```ts
  // nuxt.config
  lukk: {
    clientIpHeader: "cf-connecting-ip";
  } // or 'x-real-ip', …
  ```

  Set it and every upstream call carries that address as `X-Forwarded-For`: the app-API proxy, the lukk auth proxy, **and the server-side token refresh**. The auth paths matter as much as the app API — lukk throttles `login`, `forgot-password` and `two-factor-challenge` on the caller's IP, and `/refresh` too (30/60s by default), which in BFF mode is the highest-volume auth call of all: every proxied 401 and every SSR hydration lands there. All of those were collapsing onto one bucket.

  Security properties, unchanged by default:

  - **Off unless set.** Every browser-settable forwarding header (`x-real-ip`, `cf-connecting-ip`, `true-client-ip`, `forwarded`, …) stays blanked, and the socket address is forwarded exactly as before. The auth proxy still sends no `X-Forwarded-For` at all rather than assert an address that identifies this server rather than the visitor.
  - **A client cannot influence the value in either mode.** With the option unset the browser's own `x-forwarded-for` is never read; with it set, only the _named_ header is, and the value replaces the client's chain rather than merging with it.
  - **A list-valued trusted header is rejected outright.** A header the edge SETS carries exactly one address, but Node joins duplicates with `", "` and the **client's copy arrives first** — so on an edge that appends (or merely fails to strip the client's copy), trusting the leftmost entry would let a visitor forge `$request->ip()` upstream. Refusing turns that misconfiguration into a visible loss of function instead of a silent spoof.
  - **The value must be an exact IP** (IPv4, or IPv6 via the WHATWG host parser — not `node:net`, which is absent from worker/edge presets). It can become an upstream rate-limit key or feed an IP allowlist, so anything else is discarded rather than forwarded.
  - **The header must be one your edge SETS**, overwriting whatever the client sent (`cf-connecting-ip`, `x-real-ip`). One it merely appends to — the usual `x-forwarded-for` chain — leaves the leftmost entry client-controlled and is spoofable, so the module **warns at build** if you name one. Your upstream must also trust this hop (Laravel's `TrustProxies`) for `$request->ip()` to read it.
  - **Your origin must not be reachable except through that edge.** There is no socket-peer check here (unlike `TrustProxies`), so a directly reachable origin — leaked origin IP, no firewall on the CDN ranges — lets a client set the header itself. Lock the origin down before enabling this. Enabling it also means your auth server sees and logs visitor IPs.
  - **The auth paths assert the visitor or nothing.** Where the app-API proxy falls back to the socket address (it has always sent one), the lukk-facing calls send no `X-Forwarded-For` at all unless a visitor address was actually resolved — a wrong value there becomes a wrong rate-limit key.

  Also **documents and pins the request-header pass-through**: request headers lukk doesn't explicitly strip or overwrite reach the upstream. Apps rely on this to carry per-visitor data across the proxy hop (e.g. geo-IP copied off `CF-*` onto a prefix Cloudflare won't re-stamp), and it was only ever an implicit consequence of h3's `proxyRequest`. There's now an end-to-end test pinning it, so an allowlist refactor can't silently regress it.

  Two unrelated hardening fixes found while reviewing this:

  - The app-API proxy now blanks the step-up **confirmation header** arriving from a client, symmetric with `authorization`. In BFF mode the browser never legitimately holds a step-up token, and the auth proxy was already immune (it builds its header set from scratch) — but the app-API proxy forwards unknown headers by default, so a client-set one could reach an app API gating routes on lukk's confirmation middleware.
  - The module warns when `clientIpHeader` is set in `direct` mode, where it is dead config.

  Also fixes a pre-existing cascade this change made far more likely: a **throttled refresh no longer destroys the session**. `refreshOnce` collapsed every failure into "no pair", and the auth proxy cleared the sealed session on that — so a `429` (or a 5xx, or an unusable `baseURL`) discarded a refresh token that was never consumed and still valid, turning a transient throttle into an unrecoverable logout. It now reports whether the failure was definitive, and only lukk actually rejecting the token (401/403) ends a session. That matters here because forwarding the real client IP makes `/refresh` the highest-volume throttled call.

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

- Updated dependencies [6d1d476]
- Updated dependencies [9b1f15d]
- Updated dependencies [b2ce100]
  - lukk-core@0.10.0

## 0.9.0

### Minor Changes

- dcf5d7e: Validate `baseURL` / `api.target` at module setup, and stop reporting a misconfigured base as `"Invalid path."`.

  A `baseURL` like `"undefined/auth"` — the classic result of an unset build-time env var interpolating into a template string — is a non-empty string, so the old falsiness check accepted it. It then failed at _request_ time with `400 { "message": "Invalid path." }`, which describes the wrong fault: the path was fine, the `baseURL` wasn't. The value is compiled into the bundle, so it's knowable at build.

  **Build-time validation**

  - Setup now **fails the build** on a `baseURL`/`api.target` that isn't a valid absolute URL, naming the offending value (with any `user:pass@` masked) and the likely cause. It also catches a base that merely forgot its scheme: `new URL('localhost:3000/auth')` _succeeds_ (parsing `localhost:` as the scheme), so the check requires `http:`/`https:`, not just a parse.
  - A base carrying a **query or fragment** is rejected too. The request path is appended _after_ it, so `/auth?t=1` + `/login` resolves to `/auth?t=1/login` — every route silently hits the same upstream endpoint, including `/logout`, which would clear the local session while the refresh-token family stays live at lukk.
  - Validation runs against the **effective** config, after `runtimeConfig` is merged, so a direct `runtimeConfig` override can't slip past — including `apiBaseURL`, which is what `useLukkFetch` scopes the bearer against.
  - `nuxt prepare` **reports instead of throwing**, so a fresh clone without `.env` (the Nuxt starters wire `prepare` into `postinstall`) still installs and generates types. Only a real build is fatal.
  - `direct` mode still accepts a root-relative base (`/auth`) — the browser resolves it same-origin. Such a base now also derives an empty app-API base for `useLukkFetch` instead of aiming it at lukk's auth prefix. Note it is browser-only: don't call lukk during SSR with a relative base.
  - New warnings: a production build pointing `baseURL` at loopback, and a `bff` build that exposes the lukk URL to the browser via a public `runtimeConfig` override.

  **Honest runtime errors**

  - An unusable base now answers **`500`** (a deployment fault should reach your uptime alerting, not be filed as client noise) with `"Proxy target could not be resolved — check the lukk baseURL configuration."`, and logs the cause **once per value** rather than once per request. Genuine traversal attempts still get the generic `400 "Invalid path."`, with the rejected path truncated, escaped, and rate-capped — it's reachable unauthenticated. Response bodies never echo configuration.
  - `resolveTarget` resolves from the **parsed** base, so surrounding whitespace (a `.env` copy-paste) no longer turns every request into a false "traversal", and a query/fragment can't swallow the path.

  **Hardening**

  - `resolveTarget` rejects a non-http(s) base up front. Such a base has a `"null"` origin and an opaque, un-normalized path, so containment degraded to a bare string-prefix test — a `data:`, `blob:` or `localhost:3000/auth` base defeated traversal containment outright.
  - A protocol-relative `baseURL` in `direct` mode is now rejected at build. It previously flowed into the public app-API base, where `useLukkFetch` attached `credentials: 'include'` **and** the bearer to a cross-origin host.
  - A broken `baseURL` no longer 500s a request through the app-API proxy; it degrades to the upstream 401 that path already documents.

  **Upgrade note.** A valid absolute `baseURL` is unaffected. Configurations that now fail the build — a non-absolute `baseURL` in `bff` mode, a protocol-relative or bare-relative base in `direct` mode, and any base with a query/fragment — could not work as intended. If you **build once and deploy many**, don't bake a template string: leave `baseURL` empty (that still only warns) and supply `NUXT_LUKK_BASE_URL` at runtime. Otherwise ensure the variable is present wherever you run `nuxt build`.

### Patch Changes

- lukk-core@0.9.0

## 0.8.0

### Minor Changes

- f312200: Add `session.name` to namespace the BFF sealed-session cookie, so multiple lukk-nuxt apps can share a host without clobbering each other's session. Cookies are scoped by host, not port, so two apps on `localhost:3000` + `:3001` (or two apps under one domain via path routing) otherwise read and overwrite the same `lukk-session` / `__Host-lukk-session` cookie — logging into one silently logs the other out.

  Set a distinct slug per app:

  ```ts
  // nuxt.config
  lukk: {
    session: {
      name: "admin";
    }
  }
  // → __Host-lukk-admin-session (Secure)  /  lukk-admin-session (dev http)
  ```

  Unset keeps the existing names (`__Host-lukk-session` / `lukk-session`) byte-for-byte, so this is non-breaking. The full name is derived at each runtime site from the resolved `cookieSecure` + the namespace, so the `__Host-` prefix and the `Secure` attribute always share one source and can't diverge; `Secure`/`Path=/`/no-`Domain` are preserved.

  Note: namespacing is **de-confliction for co-hosted apps, not a trust boundary**. Apps sharing an origin (same host + path routing, or `localhost` across ports) share one cookie jar — the per-app `session.password` (the iron seal), not the cookie name, is what isolates them. Put distinct-trust apps on separate subdomains and give each a distinct strong `session.password`.

### Patch Changes

- lukk-core@0.8.0

## 0.7.1

### Patch Changes

- 4857132: Fix a BFF SSR auth flash on a full page load whose access token has aged out. The SSR-hydration plugin previously bailed on an expired access token and deferred to the client restore, so an authenticated hard refresh / redeploy / dev full-reload briefly rendered `/login` before the client corrected it.

  `session.server` now resolves the hydration token through a new `resolveHydrationAccess(event)` helper: when the access token is expired but the session is still refreshable, it rotates once (via `refreshOnce`) and re-seals **in place**, writing the fresh seal onto **both** the page response (so the browser receives the rotated cookie) **and** the in-process request cookie — so the same render's `fetchUser` forwards the already-rotated session and the app-API proxy injects the new access token instead of rotating the just-consumed refresh token a second time (a replay lukk's reuse detection would answer with a whole-family revoke). A still-valid token seeds unchanged; an anonymous or unrefreshable session mints nothing and defers to the client. The render is marked `Cache-Control: no-store` as soon as a session is resolved (not gated on the user seeding), so a rotated cookie is never left cacheable.

  SSR-only, BFF mode; no public API change. (The related http-dev cookie-name divergence was already fixed in 0.5.0 — upgrade to ≥ 0.5.0 if you still see the flash on a fresh login.)

  - lukk-core@0.7.1

## 0.7.0

### Minor Changes

- d07f6eb: Add registration (pairs with lukk's `features.registration`). `lukk-core` gains a `register(input)` client method plus `RegisterInput` / `RegisterResult` / `RegistrationPending` types and an `isRegistrationPending` guard. `lukk-nuxt`'s `useLukkAuth` gains `register()`, which mints a session exactly like `login()` — handling the same 2FA-challenge outcome and the verify-first (`block_unverified_login`) no-session response.

### Patch Changes

- Updated dependencies [d07f6eb]
  - lukk-core@0.7.0

## 0.6.0

### Minor Changes

- 1336362: Add password reset (pairs with lukk's `features.password_reset`). `lukk-core` gains `forgotPassword(email)` and `resetPassword(input)` client methods plus a `ResetPasswordInput` type; `lukk-nuxt` gains the auto-imported `useLukkPasswordReset` composable (`sendResetLink`, `reset`, and `sending`/`resetting` flags). Both endpoints are public and route through the configured transport (BFF proxy or direct).

### Patch Changes

- Updated dependencies [1336362]
  - lukk-core@0.6.0

## 0.5.0

### Minor Changes

- Local development over plain http now works in BFF mode. The module decides the sealed session cookie's `Secure` attribute once at build time (`lukk.session.cookieSecure`): Secure + `__Host-` in a production build and under `nuxi dev --https`, relaxed (plain `lukk-session`, no `Secure`) for `nuxi dev` over http — where a browser drops a `Secure` cookie even on localhost, silently losing the session. The runtime never sniffs the request scheme, so there's no `x-forwarded-proto` spoofing surface, and the relaxed cookie can't reach a production bundle. Override with `lukk: { session: { cookieSecure: true | false } }`.
- 109ada1: Accept any reasonable `user.endpoint` shape — especially Laravel's default `{ "data": {...} }` API-Resource wrapper, which previously made `useLukkAuth().user` a `{ data }` object (so `loggedIn` was `true` but every field was `undefined`).

  - **lukk-core:** new augmentable `LukkUser` interface (extend it via `declare module 'lukk-core'` to type `useLukkAuth().user` everywhere), plus `shapeUser()` and `isEmailVerified()`.
  - **lukk-nuxt:** `fetchUser` now **auto-unwraps** a clean `{ data: {...} }` wrapper (never a `meta`/`links`/`errors` envelope, and `{ data: null }` → logged-out), configurable via `user.key` (default `'data'`; `false` disables). `useLukkAuth().user` is typed `LukkUser | null`, and `verified` accepts Laravel's `email_verified_at` **or** the OIDC boolean `email_verified`. A dev-only `console.warn` fires when a "logged-in" user still looks like an un-unwrapped wrapper (no `id`), pointing at `user.key` / `$wrap = null`.

  Pairs with a new optional `Lukk\Http\Resources\UserResource` base class on the PHP side.

### Patch Changes

- Security: the BFF proxy and the app-API proxy no longer follow an upstream 3xx redirect (`redirect: 'manual'`). A trusted upstream that open-redirects could otherwise re-emit the injected bearer / `X-Lukk-Confirmation` header — and, on a 307/308, the request body — to the redirect host (CWE-918/-200). An opaque/3xx upstream response is now rejected as a `502` instead.
- Updated dependencies [109ada1]
  - lukk-core@0.5.0

## 0.4.0

### Minor Changes

- ed90bec: Email verification client (pairs with lukk's opt-in `features.email_verification`). Adds `client.sendEmailVerification()` (lukk-core) and a `useLukkEmailVerification()` composable (lukk-nuxt) exposing `verified` (computed off the loaded user's `email_verified_at`), `sending`, `sendVerificationEmail()` (resend the link), and `syncAfterVerify()` (reload the user on your verify callback page). The verify link itself is a browser navigation from the email that redirects back to your SPA — the composable owns the resend + the post-redirect sync, not the verification click.
- 9dbfe8d: Support both step-up shapes — per-page and per-action — and complete the route-guard set.

  - **Route guards:** add `lukk-verified` (send a logged-in user with an unverified email to `/verify-email`) and `lukk-confirmed` (send a logged-in user without a recent step-up confirmation to `/confirm-password`), matching `lukk-auth` / `lukk-guest`. Each acts only on an authenticated user (pair with `lukk-auth`); the server's `lukk.verified` (409) / `lukk.confirm` (423) remain the real enforcement. Use these to gate a **whole page/section**.
  - **`useLukkConfirmation` modal flow:** add `withConfirmation(action)` for a **per-action** step-up — it runs the action and, on a `423`, drops any stale confirmation, flips the new reactive `required` (bind your modal to it), waits for a fresh confirm (password _or_ passkey), and retries once. Plus `cancel()` to abort a pending prompt. This also fixes a stale-`confirmed` edge: a `423` now clears the client flag instead of leaving it optimistically true.

- 5076caa: BFF SSR auth hydration (on by default). In BFF mode the server now seeds `useLukkAuth().user` / `loggedIn` per request from the sealed session, so authenticated pages render logged-in on the first paint — no logged-out→logged-in flash and no consumer `<ClientOnly>`. A `session.server` plugin reads the sealed session read-only, and (when the access token is still valid) fetches your `user.endpoint` in-process via the same request-aware path `useLukkFetch` uses, seeding the user into the SSR payload; the client then skips the redundant restore.

  Security: only the app `user` resource enters the payload — the access/refresh token never leaves the server; a hydrated render is marked `Cache-Control: no-store` so a shared cache can't cross-serve it; prerendered/cached pages and anonymous/expired-at-SSR sessions fall back to the client restore (never a mid-render token rotation, never a minted cookie, never a 500). `direct` mode is unaffected (no server session). Opt out with `lukk: { ssrHydrate: false }`.

  **Behavior change:** SSR `useLukkAuth().user` was previously always `null` (populated only after client hydration); it is now populated during SSR in BFF mode. Review any page that special-cased "always anonymous on the server."

### Patch Changes

- 50fa215: Fix `$lukkRefresh is not a function` crashing every page load in BFF mode. `initSession` now reads the injected `$lukkRefresh` defensively (as `useLukkFetch` already did), so if the client plugin's provide isn't in effect yet it degrades to logged-out instead of throwing an app-wide error. The client plugin is also named (`lukk:client`) and the session-restore plugin now `dependsOn` it, guaranteeing the `$lukk` / `$lukkRefresh` provide is established before `initSession` runs — even under parallel plugins or layers.
- Updated dependencies [ed90bec]
  - lukk-core@0.3.0

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

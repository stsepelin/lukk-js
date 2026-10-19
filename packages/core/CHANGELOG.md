# lukk-core

## 0.12.0

### Minor Changes

- 5f2ca8b: **Types matched to what lukk sends.** `PasskeySummary.last_used_at` (from `GET /auth/passkeys`) is a unix timestamp number, not a string — it always was at runtime, so code that treated it as a string was already wrong and now fails to typecheck. `AccountExport` gains an optional `lockouts` array (purpose, attempt count, ISO-8601 timestamps) for lukk releases that include the account-lockout counters in the export.
- 945323e: **`logout({ refreshToken })` presents the refresh token.** lukk ends a session by the refresh token the client holds (the RFC 7009 shape), so a body-mode client whose access token has expired can log out without spending a rotation first — or while refreshing is throttled or failing. Older lukk releases ignore it and use the bearer.
  
  **`forgotPassword`, `resetPassword`, `changePassword` and `sendEmailVerification` resolve to `LukkStatus`** (`{ status: string }`), the acknowledgement lukk answers them with, instead of `void`.
- af8a72a: **`useLukkFetch` fails closed on credentials, and judges a per-call `baseURL` too.**
  
  The instance was built with `credentials: 'include'` and narrowed per request in an `onRequest` hook. ofetch merges per-call options by *spreading*, so a caller's own `onRequest` **replaces** lukk's — and that call then kept the `include` default and sent the origin's cookies to whatever it was pointed at. The default is now `credentials: 'same-origin'`, *upgraded* to `include` only once the target is known to be same-origin; a call that replaces the hook now under-sends rather than over-sends.
  
  The same-origin decision also looks at a per-call `baseURL`, not just the path: ofetch applies the base **after** the hook runs, so `api('/me', { baseURL: 'https://collector.example' })` looked like a same-origin `/me` at the moment the decision was made, and left with the bearer. An absolute per-call base is now accepted only on the API's own origin — or on this app's (in the browser), since in BFF mode the API base is the relative proxy mount and no absolute URL can match it. A *relative* per-call base resolves against the document, so it is accepted only where the API base is relative too.
  
  **This can drop credentials a call used to carry** — in direct mode, or for a cross-origin target. A call that passes its own `onRequest`, or one that redirects the base to another origin, no longer sends the bearer (direct mode) or the cookies (cross-origin) and will `401`. A same-origin call in BFF mode is unaffected: the browser still sends the session cookie to its own origin. Call lukk's instance without replacing its hook (wrap it instead), and keep authenticated calls on the API's own origin.
  
  `lukk-core` exports `carriesOrigin(url)` — the canonicalisation `isSameOrigin` already used, now shared, which answers whether a URL or base names an origin of its own at all.
- bdca3f2: **Aligned with lukk 0.7's contract.** `AccountExport.passkeys[]` gains `created_at`, `aaguid` and `transports` (optional — lukk 0.6.0 does not send them), and its `last_used_at` is now an ISO-8601 string rather than unix seconds, like every other time in the export: code that treated it as a number needs to parse it instead. `PasskeySummary` (`GET /auth/passkeys`) is unchanged. The two-factor and change-password composables document lukk 0.7's new refusals, and pass them through as plain `LukkError`s — no refresh, no retry, no sign-out: `confirm()` answers `409` on `code` when two-factor is already on, `regenerateRecoveryCodes()` `409` on `two_factor` without two-factor, and `confirmPassword()` (`422` on `password`) and `changePassword()` (`422` on `current_password`) from a session below the account's step-up level — an account with a second factor, signed in without it recently.
- ad1e1e5: **`LukkError` carries lukk's `reason`.** lukk answers a step-up confirmation that belongs to another session with 423 and `reason: "confirmation_session_mismatch"`, so a client can tell it from a missing confirmation without matching English text. The field was dropped; it is now passed through when it is a string.
- b88797e: **A passkey sign-in can answer with a two-factor challenge.** lukk 0.7 answers a single-factor passkey assertion on an account with confirmed two-factor with `{ two_factor, challenge_token }` instead of a session. `loginWithPasskey()` is now typed `LoginResult`, and `useLukkPasskeys().login()` resolves to it: on a challenge it sets `pendingTwoFactor`, loads no user, and `useLukkAuth().verifyTwoFactor()` completes it, as after a password sign-in. Before, the challenge was dropped and the visitor was left on the sign-in page with nothing to type the code into. A challenge that arrives after the visitor logged out is discarded, and no second logout is sent, since no session was issued.
- 9f4be14: **Passkey step-up asks lukk's own step-up options.** `useLukkPasskeys().confirm()` used the anonymous login options, which neither list the user's credentials nor ask for user verification. lukk 0.7 requires user verification at step-up whenever the account can reach AAL2 and refuses an assertion that lacks it, so a confirm made that way could never succeed. It now calls the new `passkeyConfirmationOptions()` (`POST /auth/confirm-passkey/options`) and falls back to the login options only on a 404 from an older lukk. A 403 from the options route abandons the pending confirmation, as a 403 from `confirm-passkey` already did.
  
  **BREAKING (types): `Amr` holds the RFC 8176 registered values lukk 0.7 emits:** `'pwd' | 'otp' | 'pop' | 'user' | 'mfa'`. `'webauthn'` is gone; a passkey session is `pop` + `user`, and `mfa` marks a multi-factor one.
- 7bbaa3d: **A refresh the BFF asks to retry is retried.** `LukkError` gains `retryAfter`, the server's `Retry-After` in seconds. When the BFF answers a refresh with `503` and `Retry-After` — lukk is slow to rotate — lukk-nuxt's client waits that long (at most ten seconds) and asks once more, which joins the rotation still in flight or adopts it once it has landed, instead of reporting the session unavailable until the user's next action.
- 21953a7: **A 401 is retried in BFF mode once the session has been renewed.** lukk-core retries a request after its `refresh` hook returns a token pair, and the pair is shape-gated (`isTokenPair`) so no arbitrary response body reaches `onTokens`. A BFF proxy renews the session server-side and answers the browser with no token, so that gate refused the answer and lukk-core never retried a 401 in lukk-nuxt's default mode, even right after a successful renewal.
  
  lukk-core now exports `REFRESHED_WITHOUT_TOKEN`, a symbol a `refresh` hook returns to say "renewed, and there is no token for you to hold": the request is retried once and `onTokens` is not called. A symbol can't come out of a response body, so the shape gate on real pairs is unchanged. The hook's type is now `() => Promise<RefreshOutcome>` (`TokenPair | typeof REFRESHED_WITHOUT_TOKEN | null`).
  
  In lukk-nuxt, `$lukkRefresh` resolves `REFRESHED_WITHOUT_TOKEN` in bff mode, and `$lukkRestore`'s outcome carries it as its `pair`, instead of the proxy's `{ ok, expires_in }` mislabelled as a `TokenPair`, and never write an access token there; both are still truthy on success. The `#app` types now say so — `$lukkRefresh: () => Promise<RefreshOutcome>` — and `$lukkRestore`, which was provided but untyped, is typed.
- 16912a8: **Direct mode keeps its credentials out of the payload.** The access token, the step-up token and a pending 2FA challenge lived in `useState`, which Nuxt's chunk-reload persists to `sessionStorage` (`nuxt:reload:state`) and `experimental.restoreState` re-applies, stale. They are now held on the Nuxt app; the `lukk:access`, `lukk:confirmation` and `lukk:challenge` state keys are gone.
  
  **`useLukkFetch` sends the step-up token in direct mode** — to the API's own origin only, like the bearer — so a `lukk.confirm`-gated route of the app's API can be confirmed; it answered `423` forever. A relative path with an explicitly empty `baseURL` no longer carries credentials to the page's origin when that is not the API's. App-API errors carry `retryAfter`, read by the newly exported `lukk-core` `retryAfterSeconds()`.
  
  **A 2FA challenge from an earlier attempt is dropped** by any later sign-in that issues tokens, and when another tab changes the session; redeemed later, it replaced the session just begun. **`withConfirmation()` retries once** instead of wiping a confirmation that landed while its request was out. **`useLukkForm`**: a cancelled submit rejects with the `AbortError` itself, and `onFinish` runs even when `onError` throws.
  
  **`login()`, `register()` and passkey `login()` are typed with `BffSignInResult`** (`{ ok: true, expires_in }`), what they resolve to in BFF mode, so `access_token` is not assumed. **`storage` is reserved**: any value but `'cookie'` fails the build — it was read by nothing. The proxies name the setting at fault (`baseURL` or `api.target`) when they cannot resolve their target.
- 95c76f3: **The app-API proxy reads a `.php` with nothing after it as a front controller too.** Symfony strips `SCRIPT_NAME` as a leading substring, so behind nginx + php-fpm `/api/index.phpauth/login` routed as `/auth/login` and streamed lukk's token pair out. Every `.php` in the path — and in `baseURL` — is now read as the end of a script's name, on every decoding round.
  
  **…and a front controller in a subdirectory.** Symfony strips the whole script path — and a request that merely ends in it — so with `SCRIPT_NAME` `/public/index.php`, `/api/public/index.php/auth/login`, `/api/x/public/index.php/auth/login` and `/api/public/index.phpauth/login` all reached lukk's login; only the script's own segment was dropped, and each passed. Where the path names the script but does not start with its path, Symfony cuts as many characters as the script path has, whatever they are (`/xx/index.php/abc/auth/login` is `/auth/login`): the length is the deploy's, so a path naming a `.php` is now refused wherever the segment lukk's base ends in (`auth`) appears in it whole, ended by `/`, `\`, `?`, `#` or the end — whatever comes before it, since an app mounted at `/app` routes lukk's `/app/auth` as `/auth` (`/api/oauth/callback.php` included). Checked against Symfony's own `Request` over a fuzzed corpus of ~35,000 paths and three bases: no path naming a `.php` gets through; paths without one are judged as before. A `baseURL` naming its script in a subdirectory (`/public/index.php/auth`) is read as the app routes it, `/auth`.
  
  **…in time linear in the path.** One reading per `.php`, each judged in full on every decoding round, made the check quadratic in the path, before any session was read: an unauthenticated `GET /api/` + `a.php%3F` repeated took 0.5 s of CPU at 4 KB and 7.6 s at 16 KB (22 s against a `baseURL` naming its script). A path naming more than four `.php` in any decoding round is now refused (`404`) unjudged, and the slash trimming that rescanned a long run of `/` from each slash in it — 3.4 s for `/api/` + 16 K slashes + `x`, with no `.php` at all — is linear. Both proxies now answer `414` for a path past 8 KiB as the upstream URL serialises it (the request-line limit nginx and Apache apply by default) — measured there, not as sent, since a `{` or `"` is three characters once serialised. The worst path the app-API proxy still judges takes about 90 ms of CPU. The BFF auth proxy's empty-segment check was quadratic on a trailing run of slashes (0.4 s for `/_lukk/x` + 16 K slashes, 1.9 s at 32 K, then forwarded); it is linear, and judges the same paths.
  
  **The BFF finds the journal of a session sealed before `sid` existed.** The auth proxy held the session's head and looked up its current tokens by `sid` alone, while rotations are journalled by `sid` or, for a session sealed without one — every session from before this release — h3's id. For those, a logout or a replacing sign-in after a rotation the browser never received presented the spent refresh token again (`RefreshTokenReused`), and no response was held against a late delivery.
  
  **A response that has already closed is not counted as out.** Every caller holds the session's head after an await, and a response the browser abandoned (or that was sent) meanwhile has had its `close` — which never comes again: the session stayed "out" for good, its head never expired, and the count stood against the 50,000-session bound. Such a response now counts as closing then: the head lasts the hold from there.
  
  **`useLukkAuth`: a user load the session switched accounts under is not a sign-out.** Its `SESSION_CHANGED` rejection (a `401`) was read as lukk's answer: the tab showed nobody and forgot the subject — and if the resync of the same refresh failed too, it stayed signed out while holding the new account's token, with nothing left to notice the switch. The load now asks again, once, as the account the session holds; failing that it is "couldn't tell", as any failed load, and the next refresh's resync sees the switch. A load a sign-in or logout has overtaken meanwhile does not ask again.
  
  **BFF mode type-checks.** The module's own runtime read `$lukk` as the mode's type, and under `LukkBffClient` five composables and the proxy failed `nuxi typecheck` in a bff app. It now reads the client as either mode's; `useLukkConfirmation().record()` accepts the proxy's `{ ok: true }`. The playground is type-checked in both modes.
  
  **A response still out keeps the session's head, however long it takes.** The head (the newest refresh token, which tells a late response that the session has moved past its pair) lasted five minutes after the last rotation; an app-API response has no deadline, and one delivering after that re-sealed a spent pair over the newer one — the browser's next refresh was then revoked as a replay. It now lasts ten minutes past the latest rotation, hand-out or response, and for as long as any response that may seal a pair for the session is out (bounded at 50,000 sessions, warned once).
  
  **A logout and a replacing sign-in present the session's current tokens.** After a rotation the browser never received, they sent the cookie's spent refresh token: lukk revoked the family — as a reuse, with a `RefreshTokenReused` theft alarm. They now present the journal's head, and lukk ends the session through the bearer.
  
  **lukk-core: a request made for one account is not replayed as another.** When a `401` renewal comes back for a different account (another tab signed in), the request rejects with `reason: SESSION_CHANGED` instead of being retried; `useLukkFetch` does the same. A `401` from a foreign origin, where no credentials went, is not renewed for at all. `isTwoFactorChallenge` and `isRegistrationPending` accept any value.
  
  **lukk-nuxt.** A sign-in, another tab's session change, or a renewal as another account drops the step-up (`confirmed` and the held token). `useLukkForm`: a new submit aborts the one in flight and a superseded one no longer touches the form's state; dotted error keys and a typed `nestedErrors`. An expired 2FA challenge clears `pendingTwoFactor`. A `null` rejection passes through `useLukkConfirmation` unchanged. The effective `confirmationHeader` (one set through `runtimeConfig` too) is validated. Nested module options are optional field by field; `$lukk` is typed `LukkBffClient` in BFF mode. With `experimental.restoreState`, lukk's session state is kept out of the snapshot Nuxt restores after a reload of its own.
  
  `AccountExport` types the fields lukk 0.7.0 adds to the export: each session's `amr` and `authenticated_at`, `two_factor.pending` and `recovery_codes_remaining`, and `password_reset` (all optional — older lukk releases leave them out).
  
  **The BFF auth proxy keeps an encoded `?` in the path as path data.** h3 decodes `event.path` before the handler runs, and the proxy cut it at the first `?`: `POST /api/_lukk/logout%3Fx` reached lukk as `/auth/logout` and ended the session, for a path lukk itself would answer `404`. The path now ends where the raw request target's query starts, as the app-API proxy already read it, and the containment check, the route rules, the empty-segment refusal and the `414` cap all judge that path.
  
  **`useLukkFetch` during SSR merges headers as the browser's ofetch does.** `api.create({ headers: { 'x-tenant': 'a' } })('/me', { headers: { 'x-trace': 'b' } })` sent `x-trace` alone on the server — the call's `headers` replaced the instance's — while the browser sent both. A call's headers are now merged over the instance's in any `HeadersInit` form, by name, case-insensitively, the call winning; a nested `.create()` replaces the headers it names, as ofetch's own does.
  
  **BFF: a step-up survives a slower response from the same session.** A response sealed before the confirmation and delivered after it — an app-API long-poll whose proactive refresh re-sealed the session, or the auth proxy's own 401 renewal waiting on a slow retry — landed over the confirmed cookie with the same pair and no confirmation: the next gated call reached lukk without `X-Lukk-Confirmation`, answered `423`, and the user had to confirm again. The proxy now holds each session's newest confirmation until its own expiry, and every re-sealed cookie carries it at the last moment before leaving. lukk binds a confirmation to the session's refresh family, which rotation keeps, so it carries across the session's pairs — never into another session or account. It goes with the session (logout, a replacing sign-in, a refused refresh), when lukk refuses it (`423`), and when it expires; a step-up answered "confirm again" (`409`) is never held. Bounded at 50,000 sessions, warned once.
- 3e0b0eb: **Sign-in calls no longer refresh and retry on a 401.** `login`, `register`, `twoFactorChallenge` and `loginWithPasskey` don't authenticate with the current session, so a 401 from one is the server's answer — lukk returns it for a passkey whose user no longer exists — not an expired access token. Refreshing on it rotated the refresh token of the session being replaced and then sent the credentials, or an already-spent passkey ceremony, a second time. They now reject with the 401 directly: in lukk-core's client, and in lukk-nuxt's BFF proxy for `/login`, `/register`, `/two-factor-challenge` and `/passkeys/login`.
  
  `logout()` keeps its refresh-and-retry by default, and now accepts `{ retry: false }` for a binding that renews the token itself — lukk-nuxt does, so its refresh gate can't make a logout wait on its own renewal. It also sends an empty JSON body now (`Content-Type: application/json`) instead of none: lukk releases that end a session by its refresh cookie accept that only from a request a cross-site form couldn't have made, and the JSON body is that signal.

### Patch Changes

- 411d003: **Closing the remaining session gaps, and precise types for every composable.**
  
  - **`lukk-auth` waits for the session to be resolved.** It used to redirect whenever `loggedIn` was `false` — including during a server render that couldn't resolve the session, which sent a signed-in visitor to `/login` before their client had restored them. It now defers while `ready` is `false` (the same middleware runs again on the client, after the restore), and doesn't redirect when `restoreFailed` is `true`, so the page can offer a retry. **Behaviour change:** a protected page can now render for a visitor the server couldn't identify, before the client redirects them — route middleware isn't access control; your API is.
  - **Sign-ins, logouts and refreshes queue across tabs** behind one Web Lock per app (`navigator.locks`), shared within a tab so nothing waits on itself. A logout in another tab can no longer clear the cookie a sign-in here just set, and tabs no longer present the same refresh token at once. It is best-effort: an operation waits at most 3 seconds for the lock and a tab gives it back after 10 even if its operation is still running, so a stuck tab (or any script on the origin holding the name) delays others but can't block them; and a browser without Web Locks (an older one, plain http) behaves as before. So keep lukk's `grace_seconds` above `0`, and in direct mode a logout in another tab can still, in those cases, clear a new sign-in's cookie. And a refresh that answers after a newer session replaced its own (only possible past those caps) no longer leaves the browser on the previous account in direct mode: its response had already set that account's refresh cookie over the newer one, so the tab now logs that rotation out with the token it minted (bearer only, so a newer cookie is never sent along) and tells the other tabs to re-check — the visitor reads as signed out rather than as someone else.
  - **`logout()` is sent with `keepalive`** (lukk-core), so a page that navigates away right after starting it doesn't cancel it. With a lukk release that ends a session by its refresh cookie, that one request is all a logout needs. Where a browser refuses a keepalive request needing a CORS preflight, it is sent again without. And if the page starts to unload — or goes hidden, which iOS Safari may signal instead — while a logout is still waiting (for another tab's lock, or a refresh already out), the logout is sent right away with `keepalive`; a page restored from the back/forward cache sends it again if that attempt failed. Sending early skips the cross-tab lock, so in direct mode a sign-in in another tab at that same moment can lose its cookie. And a browser fires `pagehide` only once the NEXT page's response has arrived — a request that still carried the session, so in BFF mode that page rendered signed in. A logout now leaves a note the next page load finishes it from. **BFF:** a one-minute same-site cookie (`__Host-lukk-logout`, namespaced like the session; its name is `runtimeConfig.public.lukk.logoutCookie`) written when `logout()` is called; a new server middleware ends the session through the proxy's `/logout` before the page renders (waiting at most 5 s, and leaving lukk alone for 10 s after a failure), so it renders signed out at once. It drops the note and answers with a short-lived `__Host-lukk-signed-out` cookie (ten seconds; a cookie, never the page payload, which a cache could share), and that page tells the visitor's other tabs instead of restoring. That response never carries the CLEARED session cookie — it is finalised long before it lands, and a sign-in in another tab meanwhile would lose its newer cookie to it; the browser's own logout request clears that one, and until it does every path here treats the session as ended. The signed-out answer itself is held back where it could mislead — a sign-in that replaced the session while the response was produced — along with any session cookie the logout's renewal re-sealed, which would otherwise land over that sign-in's newer one. Every response that seals a new session clears the note, so it never ends a sign-in that came after it; while the note is on a request, the server treats it as signed out — SSR hydration, `getLukkAccessToken` (in your own server middleware too) and the app-API proxy — and the response is `no-store`; if lukk can't be reached the browser finishes the logout in the background, without holding the app's startup, and stands down if a sign-in is recorded meanwhile. **Direct:** a per-tab note (`sessionStorage`, one minute) naming the session by its access token's `fid`; the next page load restores and logs out only if it restored that same session, keeping a newer sign-in from anywhere. A note with no family (no token known yet, or a `TokenIssuer` without `fid`) falls back to time: moot once a sign-in is sent after it in any tab, recorded in `localStorage`.
  - **BFF: `session.sharedStore`** names a Nitro storage mount (a strongly consistent one that expires keys — Redis, Upstash / Vercel KV; not Cloudflare KV, which can take a minute to show a write elsewhere) for the record of replaced sessions, so every server instance sees it — behind a load balancer without sticky sessions, and on serverless and edge runtimes. Without it the record stays per process; a refresh racing across instances still relies on lukk's grace window. Each store call is capped at 300 ms and a failing store is left alone for 30 seconds, so a slow or unreachable store degrades to the per-process record instead of holding up sign-ins, logouts and pages; it is reported once per server process (the Redis client may still log its own reconnect errors — see the docs for options that quiet it). A mount name that matches nothing is warned about at startup.
  - **BFF: a sign-in revokes the session it replaces** on lukk, not only in the browser. It stayed live until it expired — and when the sign-in's response never reached the browser, the browser went on using it. These revokes reach lukk from the BFF server and are metered with every other logout from that address when the session they end was already revoked — so set `clientIpHeader`, or they share one bucket.
  - **Every sign-in claims its session** (`POST /auth/session/claim`, new `claimSession()` in lukk-core), fire-and-forget. With lukk 0.7.0's `claim_seconds` on, a session not used within that window is revoked on its first later use — which ends one whose sign-in response never reached the client; claiming at once keeps an app that makes no request for a while from being signed out. Older lukk answers 404, which is ignored.
  - **BFF: a logout resent after its first response was lost** clears the dead cookie again. A logout still leaves the cookie alone when a SIGN-IN replaced that session, since the browser then holds the newer one.
  - **BFF: a session sealed before 0.12 is recognised by h3's id** on a page load that needs no refresh, so it no longer renders as the account it replaced.
  - **BFF: a page whose session needs a refresh isn't streamed.** With Nuxt 4's `experimental.ssrStreaming`, a page's headers go out after its first chunk has rendered, past the last point a re-sealed session cookie could be withheld. Such a page now opts out of streaming (Nuxt's `prefersStream`) and renders the ordinary way, where the re-seal is checked before the headers go out; a page with a still-valid token, or no session, streams as usual. (`experimental.ssrStreaming: true` makes every route streamable unless a route rule sets `streaming: false`.)
  - **`useNuxtApp().$lukk` and `$lukkRefresh` are typed** for consumers (they were `unknown`). On Nuxt 4 the `nuxtApp` a plugin receives is typed too; Nuxt 3 types that argument with an internal interface a module can't extend, so in a Nuxt 3 plugin read them from `useNuxtApp()`.
  - **BFF: a request lukk can't be reached for** answers `502` instead of escaping as a `500` with a stack trace in the log.
  - **BFF: a refresh that can't reach lukk** (the connection drops) is reported as "couldn't tell" instead of escaping the handler as a 500.
  - **Every composable now declares its return type** (`LukkAbilities`, `LukkAccount`, `LukkChangePassword`, `LukkConfirmation`, `LukkEmailVerification`, `LukkPasskeys`, `LukkPasswordReset`, `LukkTwoFactor`; `useLukkFetch` is `$Fetch`; `LukkForm<T>` marks its derived members `readonly`). The published declarations typed most of their members `any`. **This can fail a typecheck that passed before**, where code assigned to internal state (`useLukkConfirmation().required`, `token`; a form's `processing`, `data`) or relied on `any` return values.

## 0.11.0

### Minor Changes

- 700b638: **Account erasure and export** — the client half of lukk 0.6's GDPR support.

  ```ts
  const { deleteAccount, exportAccount, busy } = useLukkAccount();
  ```

  Both endpoints need step-up **and** the `lukk.account.delete` ability, so a pinned machine token is
  refused with a 403 unless it was minted carrying it. `lukk.account` does **not** satisfy it — use the
  new `canDeleteAccount` from `useLukkAbilities()` to gate a "Delete my account" button, not
  `canManageAccount`, which computes `true` for a token both routes refuse. `LUKK_ACCOUNT_DELETE` is
  exported from `lukk-core`.

  Both go through `withConfirmation`, so a missing or stale step-up surfaces your confirmation UI and
  retries once — the same flow the two-factor and passkey management calls already use. `lukk-core`
  gains `deleteAccount()` / `exportAccount()` and an `AccountExport` type.

  `deleteAccount()` clears local auth state on success. The server has already revoked every token by
  the time it resolves, so there is nothing to log out _of_ — but `user` would otherwise sit there
  describing an account that no longer exists, and route middleware would keep treating the visitor as
  signed in until something else noticed. A **failed** erasure deliberately leaves that state alone:
  the account still exists and the session is still valid.

  The export is the **auth slice only** — sessions, passkeys, whether two-factor is on. lukk knows
  nothing about your domain data, so presenting it alone as a subject-access response would
  under-disclose. Credential material is deliberately absent: a TOTP secret, recovery codes and
  refresh-token hashes are secrets whose only use is authenticating _as_ the subject, not data they
  benefit from receiving.

- 6d8ff9d: **Abilities / scopes** — the client half of lukk 0.6's coarse authorization.

  `useLukkAbilities()` exposes `can` / `cannot` / `canAny` / `canAll` over the current token's grant,
  reactive and identical in both transport modes:

  ```vue
  <script setup>
  const { can } = useLukkAbilities();
  </script>

  <template>
    <button v-if="can('orders.write')">New order</button>
  </template>
  ```

  The list is read from the loaded user — lukk's `UserResource` publishes it — because in BFF mode the
  browser never sees the access token that carries the `scope` claim. `lukk-core` exports the matcher
  (`can`, `cannot`, `canAny`, `canAll`) for use outside Nuxt, and `LukkUser` gains `abilities?:
string[]`.

  **These are UI hints, never enforcement.** The server gates every request on the token itself; this
  only lets you avoid rendering a button that comes back 403.

  `abilities` being **absent** means the server doesn't use them, and `can()` returns **true** — an
  app that upgrades without opting in must not find its UI blanked. `[]` means it does use them and
  this token was granted nothing, so `can()` returns false. `enforced` tells the two apart.

  A **logged-out** visitor is granted nothing. Falling through to the absent-list rule rendered every
  privileged control before anyone had signed in — and what renders is the entitlement taxonomy
  itself, menu items and labels named after the abilities. A signed-in user on a server that publishes
  no list still gets everything, which is the rule that keeps an un-opted-in app's UI intact.

  **`canManageSessions` / `canManageAccount`** predict lukk's _own_ gated routes, which apply to a
  **pinned** token only. `can('lukk.sessions')` is the wrong question there: an ordinary user's derived
  grant never contains it and they are never gated, so gating "sign out other devices" on it would hide
  the button from everyone. lukk's `UserResource` now publishes `token_pinned` alongside `abilities`,
  exposed as `pinned`, and `LUKK_SESSIONS` / `LUKK_ACCOUNT` are exported from `lukk-core`.

  **Abilities follow a refreshed token.** They are re-derived on every mint server-side — that is what
  makes revoking one take effect within `access_ttl` rather than lasting the life of the refresh token
  — but the client only learns a grant through the user resource, which nothing reloaded on refresh.
  A refreshed token therefore carried a new grant while the UI kept rendering from the old one: a
  control stayed visible until it 403'd, or a newly-granted one stayed hidden, until something else
  happened to reload the user. The single-flight refresh now reloads it, and only when the loaded user
  actually publishes `abilities`, so an app that doesn't use the feature pays nothing.

  A step-up that can never succeed no longer **deadlocks the confirmation modal**. A 403 from
  `confirmPassword` / `confirmPasskey` means this token may never earn a confirmation — a machine token
  without `lukk.account` — so the pending step-up is abandoned instead of waiting for a flag that
  cannot flip while each retry burns the shared throttle.

  A **malformed** `abilities` value fails closed. `abilities?: string[]` is a compile-time claim about
  a JSON body the app's own user endpoint produces, and a single-role app returning `abilities:
"admin"` used to make every helper throw a `TypeError` — which, from a `v-if="can('x')"`, takes the
  whole component render down. A present-but-unreadable value now grants nothing (the direction the
  server takes, where a non-string `scope` claim maps to an empty grant); non-string entries inside a
  real array are dropped — as are entries the _server_ would have refused at mint (a comma, whitespace,
  over 128 bytes), so the client's rule is a subset of the server's by construction rather than by
  agreement. A non-string **ability** is refused too: `can()` used to throw on one, but only for users
  holding a wildcard grant, so a narrow-grant developer saw `false` while the admin got a blank
  component. Only a genuinely absent value still means "not in use". `enforcesAbilities()`
  is exported for the distinction.

  The matcher mirrors `Lukk\Support\Abilities` exactly — `*` and `orders.*` expand in the _grant_ but
  never in the _check_ (so a caller can't widen their own question by asking `can('orders.*')`),
  `orders.*` doesn't cover the bare `orders`, and comparison is case-sensitive. The conformance suite
  runs both implementations against the same gates on a live lukk and requires them to agree, so the
  two can't drift.

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

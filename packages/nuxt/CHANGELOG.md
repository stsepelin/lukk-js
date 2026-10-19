# lukk-nuxt

## 0.12.0

### Minor Changes

- 7f737c2: **The app-API proxy refuses lukk's own routes.** In the documented layout — `api.target` is your Laravel app and `baseURL` is the same app under `/auth` — `POST /api/auth/login` from any same-origin script was proxied to lukk and its `{ access_token, refresh_token }` streamed straight to the browser, and `/api/auth/confirm-password` handed back the step-up token: exactly what BFF mode exists to keep server-side. A request whose upstream URL falls under lukk's base path now answers 404, decided on the resolved URL the way Laravel's router reads it (dot segments collapsed, trailing slash trimmed, `%2F` and other escapes decoded, case-insensitively), and regardless of host, since the same app is often configured under a public name for `api.target` and an internal one for `baseURL`. When lukk is mounted at the root of the same host as `api.target` there is no path that tells the two apart, so the app-API proxy refuses everything; move lukk under a prefix or onto its own host. An unresolvable `baseURL` now fails the app-API proxy closed with a 500 naming the setting.
  
  If your client called lukk's routes through `/api/...`, call them through the composables (the `/api/_lukk` auth proxy) instead.
  
  **It also forwards the request target as sent and varies by Cookie.** h3 percent-decodes `event.path` before the handler runs, so an encoded `?` or `#` in a path segment (`/files/a%3Fb`) became a real query or fragment on the way upstream; the query now comes from the raw request and the path's `?`/`#` stay encoded. Responses now carry `Vary: Cookie` (merged with the upstream's own `Vary`) alongside `private, no-store`, as the auth proxy's already did.
- 383a6ed: **The BFF auth proxy decides its route rules on the URL lukk will receive.** It compared the raw request path to `'/refresh'`, `'/logout'` and the sign-in routes as strings, while the upstream URL collapses dot segments and Laravel trims a trailing slash — so `/api/_lukk/./refresh`, `/refresh/` and `/a/../refresh` reached lukk's refresh route as an ordinary proxied call (the never-proxy-refresh rule bypassed), a sign-in spelled that way was refreshed and retried on a 401, and a logout spelled that way didn't clear the cookie. Every rule now reads the route the way Laravel's router does. An encoded `#` or `?` in the path (`%23`, `%3F`) now stays path data instead of becoming a fragment or query on the way upstream.
  
  **Its responses say what they are.** A non-JSON upstream body (a WAF or proxy error page, say) went out as `text/html` on your app's origin; it is now `text/plain; charset=utf-8`, JSON is labelled `application/json; charset=utf-8` (a bare JSON string or `null` keeps its JSON form instead of becoming HTML or a 204), and every response carries `X-Content-Type-Options: nosniff`.
  
  **It bounds the request body.** The body is buffered before anything else, on routes reachable unauthenticated. A declared `Content-Length` over the new `bodyLimit` option (default 1 MiB) now answers `413` before anything is read, a chunked body — which declares no length — answers `411`, and the bytes are measured again once read. The app-API proxy streams and is unaffected.
- af8a72a: **`useLukkFetch` fails closed on credentials, and judges a per-call `baseURL` too.**
  
  The instance was built with `credentials: 'include'` and narrowed per request in an `onRequest` hook. ofetch merges per-call options by *spreading*, so a caller's own `onRequest` **replaces** lukk's — and that call then kept the `include` default and sent the origin's cookies to whatever it was pointed at. The default is now `credentials: 'same-origin'`, *upgraded* to `include` only once the target is known to be same-origin; a call that replaces the hook now under-sends rather than over-sends.
  
  The same-origin decision also looks at a per-call `baseURL`, not just the path: ofetch applies the base **after** the hook runs, so `api('/me', { baseURL: 'https://collector.example' })` looked like a same-origin `/me` at the moment the decision was made, and left with the bearer. An absolute per-call base is now accepted only on the API's own origin — or on this app's (in the browser), since in BFF mode the API base is the relative proxy mount and no absolute URL can match it. A *relative* per-call base resolves against the document, so it is accepted only where the API base is relative too.
  
  **This can drop credentials a call used to carry** — in direct mode, or for a cross-origin target. A call that passes its own `onRequest`, or one that redirects the base to another origin, no longer sends the bearer (direct mode) or the cookies (cross-origin) and will `401`. A same-origin call in BFF mode is unaffected: the browser still sends the session cookie to its own origin. Call lukk's instance without replacing its hook (wrap it instead), and keep authenticated calls on the API's own origin.
  
  `lukk-core` exports `carriesOrigin(url)` — the canonicalisation `isSameOrigin` already used, now shared, which answers whether a URL or base names an origin of its own at all.
- cf4d9db: **`useLukkForm`'s `rememberKey` is namespaced.** The draft lived in `useState(rememberKey)`, a key global to the app, so `rememberKey: 'lukk:user'` made the draft the signed-in user's state, and any app key could be overwritten the same way. It now lives at `lukk:form:<rememberKey>`. A draft remembered under the old key is not carried over.
  
  **The cross-tab channel closes with the app.** The `BroadcastChannel` the client plugin opens was never closed; an unmounted app (HMR, a micro-frontend) kept answering other tabs. It is now closed on `app.onUnmount` (Vue 3.5+), and nothing announces on it afterwards.
  
  Also: reading the direct-mode pending-logout note no longer relies on a caught `TypeError` to detect a missing note.
- f3ef4eb: Develop against Nuxt 4, keep supporting Nuxt 3. `@nuxt/kit` widens to `^3.13.0 || ^4.0.0`; the playground and the conformance apps move to Nuxt 4, and the "oldest supported Nuxt" job still installs the declared 3.x floor — now including the playground, which is its own workspace package. Nuxt 4's tsconfig turns on `noUncheckedIndexedAccess`, which the access-token decoder now satisfies without adding a branch no input can reach.
- b88797e: **A passkey sign-in can answer with a two-factor challenge.** lukk 0.7 answers a single-factor passkey assertion on an account with confirmed two-factor with `{ two_factor, challenge_token }` instead of a session. `loginWithPasskey()` is now typed `LoginResult`, and `useLukkPasskeys().login()` resolves to it: on a challenge it sets `pendingTwoFactor`, loads no user, and `useLukkAuth().verifyTwoFactor()` completes it, as after a password sign-in. Before, the challenge was dropped and the visitor was left on the sign-in page with nothing to type the code into. A challenge that arrives after the visitor logged out is discarded, and no second logout is sent, since no session was issued.
- 9f4be14: **Passkey step-up asks lukk's own step-up options.** `useLukkPasskeys().confirm()` used the anonymous login options, which neither list the user's credentials nor ask for user verification. lukk 0.7 requires user verification at step-up whenever the account can reach AAL2 and refuses an assertion that lacks it, so a confirm made that way could never succeed. It now calls the new `passkeyConfirmationOptions()` (`POST /auth/confirm-passkey/options`) and falls back to the login options only on a 404 from an older lukk. A 403 from the options route abandons the pending confirmation, as a 403 from `confirm-passkey` already did.
  
  **BREAKING (types): `Amr` holds the RFC 8176 registered values lukk 0.7 emits:** `'pwd' | 'otp' | 'pop' | 'user' | 'mfa'`. `'webauthn'` is gone; a passkey session is `pop` + `user`, and `mfa` marks a multi-factor one.
- 945323e: **The app-API proxy refuses cross-site subresource GETs too.** It injects the bearer from the sealed session, and only checked the origin of state-changing requests — so a same-site sibling's `<img src="/api/export">`, or another site's frame, was answered as the visitor. It now refuses them with `403`, as the auth proxy does. Both proxies exempt only a **top-level** navigation (`Sec-Fetch-Dest: document`): a navigation into an `<iframe>`, `<frame>`, `<embed>` or `<object>` is another site's doing, not a link the visitor followed.
  
  **App-API responses can't run as the app.** Every proxied response now carries `X-Content-Type-Options: nosniff`, and one that is neither JSON nor a PDF carries `Content-Security-Policy: sandbox`, added to the upstream's own policy — so an HTML or SVG document from the API renders with an opaque origin and no script.
  
  **The app-API proxy refuses double-encoded routes to lukk.** A path that one more round of percent-decoding turns into one of lukk's routes (`/api/x/%252e%252e/auth/login`, `/api/%2561uth/login`) is refused with `404`, so a decoding hop in front of the app cannot hand the browser lukk's token responses.
  
  **Stripped request headers are removed, not sent empty.** The app-API proxy blanked the browser's `Origin`, `Cookie`, spoofable forwarding headers and those named in `Connection`, and they reached the upstream present but empty — an empty `Origin` is still one a CORS layer judges. They are now dropped.
  
  **`/api/_lukk/refresh` accepts `POST` only**, answering anything else with `405` and `Allow: POST`.
- 21953a7: **A 401 is retried in BFF mode once the session has been renewed.** lukk-core retries a request after its `refresh` hook returns a token pair, and the pair is shape-gated (`isTokenPair`) so no arbitrary response body reaches `onTokens`. A BFF proxy renews the session server-side and answers the browser with no token, so that gate refused the answer and lukk-core never retried a 401 in lukk-nuxt's default mode, even right after a successful renewal.
  
  lukk-core now exports `REFRESHED_WITHOUT_TOKEN`, a symbol a `refresh` hook returns to say "renewed, and there is no token for you to hold": the request is retried once and `onTokens` is not called. A symbol can't come out of a response body, so the shape gate on real pairs is unchanged. The hook's type is now `() => Promise<RefreshOutcome>` (`TokenPair | typeof REFRESHED_WITHOUT_TOKEN | null`).
  
  In lukk-nuxt, `$lukkRefresh` resolves `REFRESHED_WITHOUT_TOKEN` in bff mode, and `$lukkRestore`'s outcome carries it as its `pair`, instead of the proxy's `{ ok, expires_in }` mislabelled as a `TokenPair`, and never write an access token there; both are still truthy on success. The `#app` types now say so — `$lukkRefresh: () => Promise<RefreshOutcome>` — and `$lukkRestore`, which was provided but untyped, is typed.
- 16912a8: **Direct mode keeps its credentials out of the payload.** The access token, the step-up token and a pending 2FA challenge lived in `useState`, which Nuxt's chunk-reload persists to `sessionStorage` (`nuxt:reload:state`) and `experimental.restoreState` re-applies, stale. They are now held on the Nuxt app; the `lukk:access`, `lukk:confirmation` and `lukk:challenge` state keys are gone.
  
  **`useLukkFetch` sends the step-up token in direct mode** — to the API's own origin only, like the bearer — so a `lukk.confirm`-gated route of the app's API can be confirmed; it answered `423` forever. A relative path with an explicitly empty `baseURL` no longer carries credentials to the page's origin when that is not the API's. App-API errors carry `retryAfter`, read by the newly exported `lukk-core` `retryAfterSeconds()`.
  
  **A 2FA challenge from an earlier attempt is dropped** by any later sign-in that issues tokens, and when another tab changes the session; redeemed later, it replaced the session just begun. **`withConfirmation()` retries once** instead of wiping a confirmation that landed while its request was out. **`useLukkForm`**: a cancelled submit rejects with the `AbortError` itself, and `onFinish` runs even when `onError` throws.
  
  **`login()`, `register()` and passkey `login()` are typed with `BffSignInResult`** (`{ ok: true, expires_in }`), what they resolve to in BFF mode, so `access_token` is not assumed. **`storage` is reserved**: any value but `'cookie'` fails the build — it was read by nothing. The proxies name the setting at fault (`baseURL` or `api.target`) when they cannot resolve their target.
- 80577e2: **Sealed BFF sessions now expire.** Every seal was written with no expiry, so a session cookie copied out of a browser could be unsealed indefinitely. Each seal is now written with a lifetime — new option `session.maxAge`, in seconds, default 30 days (lukk's default `refresh_ttl`) — which iron stamps into the seal and checks on every unseal; an expired seal reads as no session. Every refresh re-seals, so an active session is bounded by lukk's refresh family as before. Keep `maxAge` at least as long as lukk's `refresh_ttl`, or idle sessions end before their refresh token does. Seals written by earlier versions carry no expiry until they are next re-sealed.
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
- f6febf1: **`useLukkAuth().ready`, `whenReady()` and `restoreFailed`** — tell "not resolved yet" and "couldn't reach the server" apart from "anonymous".
  
  `loggedIn: false` meant all three, so a redirect, a fetch of account-scoped data, or a deep-link restore could act on an unresolved session and silently do the wrong thing, with nothing to retry on.
  
  ```ts
  const { ready, loggedIn, restoreFailed, whenReady } = useLukkAuth()
  ```
  
  **`ready`** becomes `true` once the session restore has finished; **`whenReady()`** resolves at that moment.
  
  **Where the gap actually is.** Nuxt awaits the `lukk:session-restore` plugin before the initial navigation and before mounting, so on the client, route middleware, `setup()` and `onMounted` already see the restore finished. The gap is the **server render** whenever it did not hydrate a user — an anonymous visitor, direct mode, `ssrHydrate: false`, prerendered routes, a session the server couldn't refresh, or a user endpoint that failed on the server. There `loggedIn` is `false` because the server cannot tell, and a `useAsyncData` that skipped on it baked an empty result into the payload that hydration never re-ran. `ready` is `false` in all of those renders, so code can defer to the client (for data: `useAsyncData(key, handler, { server: ready.value })`).
  
  It is `true` from the first line when the server hydrated the user, so that path stays synchronous. An app that doesn't read the new fields keeps its behaviour, apart from the race fixes below.
  
  **`restoreFailed`** separates a restore that reached no answer from a real signed-out visitor. Only a 401/403 means "no session" — the rule `fetchUser` already used. Anything else sets it: a throttled refresh (429), a server error (5xx, including the BFF's 503), an unreachable server, a user endpoint that fails right after a successful refresh — and a misconfigured endpoint, where retrying cannot help. `initSession()` is the retry. The flag is cleared by every definitive answer: a user loaded, a 401/403, a sign-in, `logout()`.
  
  It is read through a restore-specific variant of the SAME single-flight refresh — provided internally as `$lukkRestore` — so a boot restore still cannot race a request's own 401 retry and replay the rotating refresh token.
  
  **Fixed: a slow restore or user load could show the wrong account, or sign a user back in after `logout()`.** Offering `initSession()` as a retry made these easier to hit, but they predate it:
  
  - A restore still loading the previous account when someone signed in replaced the new user on screen with the old one, while requests carried the new token.
  - A refresh that answered after `logout()` wrote its access token back, and a restore joining it signed the user in again. A `fetchUser()` that answered after `logout()` did the same for the user.
  - A late refresh's response also re-set the refresh cookie (direct) or the sealed session (BFF) after a login or logout had replaced it.
  
  - A `logout()` while a sign-in's response was still on the wire left the visitor signed in with no token and a revoked session.
  - In direct mode, the refresh cookie is shared by every tab: another tab's sign-in, or a refresh slower than the wait below, left this tab showing one account while its next refresh acted as another. A refresh whose token names a different subject (`sub`) than the loaded user now reloads the user.
  
  Sign-ins (password, register, two-factor, passkey) are now a session handover. They wait for a refresh already in flight before sending — at most 10 seconds, so a refresh that never answers cannot lock anyone out — and a refresh that starts while one is on the wire waits for it, then isn't sent at all if a new session began. `logout()` waits for an in-flight refresh the same way, authenticates with the token it minted, and holds back a refresh that starts while it is out. When lukk rejects its access token (an idle user whose token expired, an erased account), `logout()` renews the token itself and retries once, rather than through lukk-core's own retry — whose refresh would wait on that same logout for the full 10 seconds. That renewal is one more round trip, so **await `logout()` before navigating away**. It can reject after clearing local state: a `401` whose refresh did not itself fail means there was no session left; anything else (a network failure, a throttled logout, a 401 after a refresh that couldn't be reached) means it may still be live — offer a retry there rather than navigating on. And a full page load that cancels the renewal leaves the session unrevoked (in direct mode; the BFF renews server-side). A sign-in also waits for a logout still running in the same tab, including the gap while it renews its token, whose cleanup and cleared cookie otherwise landed after the new session and signed it out; and a user reload the renewal started can no longer land after the logout and sign the user back in.
  
  A tab that signs in or logs out now tells the app's other open tabs through a `BroadcastChannel` (where the browser has one). They drop what they had in flight and re-check — a BFF tab reloads its user, a direct tab renews from the shared cookie first — instead of showing an account the browser no longer holds while their requests act as another. (Across tabs, sign-ins, logouts and refreshes also queue behind a Web Lock — see the session-gaps entry.) A sign-in that issues a session, and every `logout()` before it sends its request, starts a new session generation; a refresh, restore or `fetchUser()` from an older one discards its result instead of writing it. A sign-in that answers after a `logout()` ends the session it was issued rather than signing in. One that started no session (rejected credentials, a two-factor challenge, a registration awaiting verification) changes nothing.
  
  The wait is capped, so in direct mode a refresh slower than 10 seconds can still land its cookie after the new session's. The BFF proxy closes the rest on the server — see the replaced-session entry.
  
  Also fixed: after `clearNuxtState()`, an existing `useLukkAuth()` read `loggedIn` and `pendingTwoFactor` as `true`. And `useLukkAuth()` now has a declared return type, `LukkAuth` — the published declarations typed `user`, `loggedIn` and `pendingTwoFactor` as `any`, so an assignment to them type-checked. **This can fail a typecheck that passed before:** `user` is now `Ref<LukkUser | null>`, and `LukkUser` declares only what lukk knows about — so `user.value.name` fails, and so does `user.value?.name`, until the app augments it (`declare module 'lukk-core' { interface LukkUser { name: string } }`). An assignment to `loggedIn` fails too. `LukkAuth` is also auto-imported as a global type, so an app type of the same name now clashes.
  
  Deliberate limits:
  
  - **An anonymous server render is never marked `ready`.** It isn't `no-store`, so a shared cache may serve it to a signed-in visitor whose cookie the edge ignored — and a baked-in `ready: true` would stop that visitor's client from restoring. Only a hydrated, per-user, `no-store` render carries it.
  - **`whenReady()` resolves immediately on the server**, whatever `ready` says: the client restore never runs there, and waiting would hang the render. Read `ready` afterwards in code that also runs on the server.
  - **Reading `ready` in a template on a server-rendered page causes a hydration mismatch** when the server didn't hydrate a user; `restoreFailed` does when the client restore then fails. Use them in logic, or inside `<ClientOnly>`.
  - **A plugin that awaits `whenReady()` in its setup must run after the restore** — put it in a `.client.ts` file with `dependsOn: ['lukk:session-restore']`. The restore plugin is client-only, so a universal plugin naming it is reported (logged as an error during the build on Nuxt 3 and earlier 4.x releases, which still succeeds; only a development warning on recent Nuxt 4). Awaiting it earlier can deadlock startup, and depending on `lukk:client` doesn't prevent that; this is warned about in development.
  - **`ready` survives `clearNuxtState()`**, a common logout idiom, which would otherwise leave every later `whenReady()` pending. `restoreFailed` does not: it reads as `false` afterwards until the next restore.
- 6927e18: **`useLukkFetch` keeps the visitor's cookies on your app.** During SSR it forwarded every cookie the browser sent your app — analytics, CSRF, a co-hosted app's session — to the API base, which in direct mode is usually another host (`api.example.com`). The API's own cookies never reach your app's server in direct mode, so this sent that host everything except what it owns. The visitor's cookies now go only to the app itself (the BFF proxy mount); an absolute API base gets none. If your direct-mode SSR relied on cookies reaching the API, make that call from the browser or from a server route.
  
  **It no longer trusts the request's `Host` on the server.** The app's own origin, used to accept an absolute URL that spells out the BFF mount, came from `Host` / `X-Forwarded-*` during SSR, so an absolute URL on a host the request named was treated as this app and sent the sealed session. On the server an absolute URL is now never "this app"; use a path.
  
  **It keeps your `Accept`.** `Accept: application/json` is set only when you didn't set one, so a non-JSON route behind `api.forceJson: false` is reachable through it.
  
  **The SSR BFF instance is a real `$Fetch`.** `.raw`, `.create` and `.native` were undefined during SSR (a bare function cast to the type), and a `Request` argument threw; all now work, with the same credential rules as a plain call.

### Patch Changes

- c77accb: **BFF mode works under a non-root `app.baseURL`.** Nitro mounts every server route under the app's base path, but the client reached the auth proxy at a root-relative `/api/_lukk`, as did `useLukkFetch`'s relative app-API base and the server's own logout finish — so with `app.baseURL: '/admin/'` every sign-in, refresh and logout went to the origin root. All three now resolve under the base, read at runtime.
  
  **The BFF session cookie survives a browser restart.** It carried no Max-Age, so it was a session cookie: BFF users were signed out whenever the browser closed, while direct-mode users kept lukk's persistent refresh cookie. It now lives for `session.maxAge` (30 days), restarting on every write as the seal does, and a cleared session's cookie is deleted outright.
  
  **A step-up still waiting is cancelled when its session ends.** After a 423, `withConfirmation()` waited for `confirmed` with nothing to stop it, so after a logout — or another account signing in on the tab — the next confirmation resolved it and the old action (a passkey deletion, say) ran unasked. Logout and every sign-in now cancel it.
  
  **`whenReady()` settles even if its caller unmounts first.** Its watcher was created in the caller's effect scope, so a component unmounting before the session resolved stopped it and the promise never settled. It now watches in a scope of its own.
- 945323e: **`user.endpoint` resolves under `app.baseURL` in BFF mode**, like the proxy mount it points at — an app served under `/admin/` fetched its user from the origin root. An app that worked around this with a base-prefixed relative endpoint (`'/admin/api/me'` under `/admin/`) now fetches `/admin/admin/api/me`: drop the prefix (see UPGRADE.md). In direct mode `useLukkFetch` no longer prefixes a relative `api.target` with the app's base: there it names an API served beside the app, not a route of it.
- 749f657: **BFF: a refresh still in flight can no longer put a replaced or logged-out session back.** The browser keeps whichever `Set-Cookie` arrives last. A request that was already out when someone signed in or logged out — an app-API call renewing an expired token, a page render, another tab's restore — refreshed the OLD sealed session and re-sealed it on the way back. After a login that put the previous account back under the new one; after a logout it re-created the cookie logout had just cleared. The browser tab can hold back its own refreshes, but not these.
  
  Each sign-in now gives the sealed session a new id, and a sign-in or logout records the id it replaced for ten minutes. Every path that re-seals after a refresh — `/api/_lukk/refresh`, the auth proxy's 401 retry, the app-API proxy's proactive refresh, SSR hydration, and a step-up confirmation — checks it before rotating and again as late as it can — after the upstream body has been read, right after the user loads during a render, and once more before the render's headers go out — withholding the session cookie if the session ended meanwhile. (With Nuxt 4's opt-in `experimental.ssrStreaming` a page's headers leave too late for that, so a page that needs a refresh is taken off streaming and re-seals on the ordinary path — see the session-gaps entry.) A page render for a replaced session renders signed out and unresolved rather than as that account, so the client restores with the cookie the browser now holds — including when the render throws. `/api/_lukk/refresh` answers `409` for a replaced session, and so does a step-up confirmation captured for one (the confirmation belonged to that session and isn't stored); a restoring tab waits a moment and asks once more (the browser most likely holds the newer cookie by then), treating a second `409` as signed out rather than "couldn't tell", and a tab that was already signed in reloads its user so it stops showing the previous account. A restore retry answered "no session" now also clears a user still on screen.
  
  With SSR hydration on (the default), a render for any request carrying a real session is now `no-store`, including one that ends up not hydrating because that session was replaced: components that fetch during SSR without gating on `ready` still render its data. With `ssrHydrate: false` the same holds: the step that renews an aged-out session before the render marks it `no-store` too.
  
  A logout from a session a sign-in has already replaced no longer clears the cookie: that cookie belongs to the newer session, and clearing it signed that session out in the browser while leaving it alive on lukk. And when the proxy drops a rotation it has already made (the session was replaced while the refresh was out), it logs those new tokens out in the background — otherwise a browser still holding the old cookie replayed a consumed refresh token later, and lukk's reuse detection revoked the family and reported a theft that never happened. A console warning fires once if more than 50,000 sessions are replaced within ten minutes and the oldest stop being guarded.
  
  **Logout clears the sealed session only once the session is over** — lukk answered `2xx`, or rejected credentials that can't be renewed. A throttled logout (`429`), an upstream outage, or a `401` whose refresh merely failed used to clear the cookie anyway, leaving the session live on lukk with nothing pointing at it while the visitor believed they had logged out. The status now reaches the client, which can retry.
  
  **Logout presents the session's refresh token to lukk** as well as the access token, so a lukk release that accepts it can end the session even when the access token has expired and refreshing is throttled or failing — without spending a rotation first. Older releases ignore it.
  
  **The proxy no longer reuses a refresh token that lukk's response didn't include.** A sign-in without one fell back to the refresh token of the session being replaced, and a rotation without one kept the token lukk had just consumed: the first turned the browser back into the previous account at the next refresh, the second replayed a consumed token into a false theft report. Without a refresh token the session now simply ends when its access token does. lukk always returns one in body mode; this only matters for a cookie-mode upstream or a rebound `LoginResponse`. And a logout from a replaced session still renews its expired token and sends an authenticated `/logout`, so lukk revokes that session instead of leaving it alive — only the result is never written back.
  
  Each sign-in adds the id to the sealed session — about 45 bytes of JSON, more once sealed — worth knowing if yours is already near the 4 KB cookie limit.
  
  Also fixed on the way:
  
  - **The server-side refresh single-flight is keyed by the session's own id**, not h3's. A sign-in re-seals the new session under the old h3 id, so a refresh for it could join one still out for the session it replaced — and seal that session's tokens under the new one.
  - **SSR hydration and the proxies now share one single-flight.** Nitro's handlers and the Nuxt app's server bundle each carry their own copy of the module, so a page render and a proxy refreshing the same session at once each rotated the token. Both registries now live on `globalThis`.
  
  Limits: what remains is the time between a response's headers leaving the server and the browser storing them. The record is per server process unless `session.sharedStore` is set (see the session-gaps entry). A replaced session's token can still be rotated by a refresh that was already out; it is never written back, and those new tokens are logged out in the background. A session sealed before this version has no id of its own and is recorded by h3's.
- 758d857: **The app-API proxy now blanks the path and scheme forwarding headers a browser can set, not only the address ones.**
  
  `X-Forwarded-Prefix`, `X-Forwarded-Scheme`, `X-Forwarded-SSL`, `X-Forwarded-URI`, `X-Original-URL` and `X-Rewrite-URL` used to reach your API as the browser sent them. Symfony and Laravel honour a trusted proxy's `X-Forwarded-Prefix` and apply it to the base path of every URL the app generates, so a browser-set value rewrote the links the app renders and emails. The others are the same idea through other front ends; `X-Original-URL`/`X-Rewrite-URL` have repeatedly been used to reach paths a front-end ACL believed it blocked. They no longer reach the API at all — the proxy removes them, like `X-Real-IP` and the rest of the forwarding set. If your API relied on one of them arriving from the browser through the proxy, that no longer happens; one set by your own edge in front of Nuxt is unaffected.
- 3867f9f: **BFF: a logout tells the other tabs the moment it is asked for, not only once it lands.** The announcement was made after the request had finished — but the case it exists for is a page that navigates away as it logs out, which cancels that request and everything after it. The other tabs were then never told, and went on showing the account for as long as they stayed open. Only ever seen where the round trip is slow enough for the navigation to win, so it read as a flaky test rather than as the bug it was. Announcing first is sound because the logout note is a cookie by then: it rides the other tabs' own requests, and every server path that reads the session treats a request carrying it as signed out. Direct mode is unchanged — its note is per tab, so a tab told early would renew from the shared cookie, succeed (the session is still live at that point) and learn nothing.
- 3a228eb: **Direct mode: fixes a regression that stopped the user ever loading when the lukk base URL is absolute.**
  
  Unreleased, but worth naming because nothing in the test suite could see it. `loadUser` asks for the configured `user.endpoint` with `baseURL: ''` — ofetch's idiom for "take this path exactly as given". The new per-call origin check read that empty base as a *relative* one and refused it against an absolute API base, so on any direct-mode app configured the way the docs show (`baseURL: 'https://api.example.com/auth'`), sign-in succeeded and the user then never loaded: no bearer, a `401`, a refresh-token rotation spent on the retry, another `401`, and the route middleware bouncing the visitor back to `/login`.
  
  An empty per-call base is now treated as absent. The conformance suite builds one of its two direct modes against an absolute lukk base for this reason — every direct topology it ran before was relative, which is the one shape the bug could not reach.
  
  Also narrowed: this app's own origin stands in for the API's only where the API base is the relative BFF proxy mount, which is the case that needs it (`isSameOrigin` refuses every absolute URL against a relative base). With an absolute API base the app's origin is a different host that the bearer was never scoped to — and during SSR it comes from the `Host` header.
- 6fae718: **A second `logout()` while one is in progress joins it.** A double click ran two logouts back to back: the second went out after the first had ended the session, got a 401 it couldn't renew, and rejected — leaving behind the logout note it had just written, so the next page load set out to finish a logout that was already done. Concurrent calls now share one logout and both resolve with it. A session that a sign-in issued while a logout was out is still ended by a logout of its own.
- dc06a87: **The logout note's cookie names now follow a runtime `cookieSecure` override.** The names the browser writes the BFF logout note (and reads the signed-out answer) under were baked into public runtime config at build, from the build's `cookieSecure`, while the server derived them from the runtime value; overriding it at runtime left the browser writing a note the server never read. The server now restates both names in each request's public config before anything renders, so the page always carries the names its own server reads. Setting `runtimeConfig.public.lukk.logoutCookie` by hand alongside such an override is no longer needed.
- 2e74233: **The logout note carries the moment the logout was asked for, and a few narrower fixes around it.**
  
  - **BFF: a stale note could end the session a sign-in had just created.** The page that finishes a note stamped its own *load* time as "when this logout was asked for", while the evidence that stands a logout down is the moment a sign-in was *sent*. A sign-in already on the wire — sent before that page loaded, landing after it — therefore never counted as "since", and the note went on to end it. The note now carries the original time (`__Host-lukk-logout` holds it; renewing the minute carries it forward and never walks it past a sign-in in flight), and a note written by an older release, which has no time in it, falls back to the previous behaviour.
  - **A same-origin script could veto every logout.** `signedInSince` believed a sign-in record up to five seconds ahead of now, but lukk-js clamps everything it writes to the present — so that window only ever admitted a *forged* record. Anything on the origin could plant one on a timer and make every `logout()` stand down: local state cleared, the request never sent, the session live. There is no tolerance window now.
  - **Direct mode: a note written before a backwards clock correction never aged out.** Its age was negative, so its minute never elapsed, while the equally-future sign-in record was disbelieved and nothing could stand it down — every page load for the next hour ended whatever session the tab held. A note dated in the future is now ignored outright.
  - **Direct mode: a stood-down logout left the page reading as signed out** on the one restore branch that never cleared the flag. The session is live and already restored there, so only the flag was wrong; it self-healed on the next page load.
- bdca3f2: **Aligned with lukk 0.7's contract.** `AccountExport.passkeys[]` gains `created_at`, `aaguid` and `transports` (optional — lukk 0.6.0 does not send them), and its `last_used_at` is now an ISO-8601 string rather than unix seconds, like every other time in the export: code that treated it as a number needs to parse it instead. `PasskeySummary` (`GET /auth/passkeys`) is unchanged. The two-factor and change-password composables document lukk 0.7's new refusals, and pass them through as plain `LukkError`s — no refresh, no retry, no sign-out: `confirm()` answers `409` on `code` when two-factor is already on, `regenerateRecoveryCodes()` `409` on `two_factor` without two-factor, and `confirmPassword()` (`422` on `password`) and `changePassword()` (`422` on `current_password`) from a session below the account's step-up level — an account with a second factor, signed in without it recently.
- 40b23ad: **Packaging and typing fixes.** `LUKK_BFF_PREFIX` and `LUKK_SESSION_COOKIE` can be imported as values again: the published type entry re-exported them type-only, so `import { LUKK_BFF_PREFIX } from 'lukk-nuxt'` failed with TS1362. `h3`, which the server runtime imports, is now a declared dependency rather than a hoisting accident. The internal `refreshOnce` helper is no longer auto-imported into your server code. `$lukk` and `$lukkRefresh` are typed in templates. The loopback-`baseURL` warning no longer fires during `nuxi prepare`/`typecheck`.
  
  **A hung lukk no longer stalls a request.** The BFF's calls to lukk give up after 15 seconds and are treated as the outage they are — except the refresh itself, which is never aborted (a rotation lukk has made must not be lost); its callers stop waiting after 15 seconds instead. **A browser that returns no passkey credential** gets an error naming it, rather than a TypeError from the serialiser.
- 553dfbd: **`useLukkFetch`: a per-call `baseURL` that is not a primitive string no longer gets credentials.**
  
  The credential check read any non-string per-call `baseURL` as "no base" and cleared the request on its path alone. But ofetch applies every truthy base, and ufo resolves a boxed `new String('https://collector.example')` to that host, so the bearer and `credentials: 'include'` went there. Judging the object by its string value is not safe either: ufo coerces it twice with different hints, so an object that answers differently to each passes as the API and is sent elsewhere. Such a value is now refused. The request still goes out, without credentials. TypeScript already rejects it, so reaching it takes a cast in the app's own code. `''` and `null` still mean "no per-call base", as they do to ofetch.
- 48f2662: **The app-API proxy keeps the app origin's CORS policy its own.** It passed the upstream's `Access-Control-*` response headers through and forwarded the browser's `Origin`, so an upstream that echoes `*.example.com` with credentials let a sibling subdomain read authenticated GETs, the bearer injected by the proxy. CORS response headers, and the upstream's hop-by-hop headers (RFC 9110 §7.6.1), are now dropped, and `Origin` is removed from the request upstream.
  
  **The BFF auth proxy refuses a cross-site or same-site GET that is not a top-level navigation.** A sibling's `<img src="/api/_lukk/account/export">` was answered with the sealed session and confirmation token, spending the user's step-up throttle. Top-level navigations, such as a link in an email, still pass.
- dadc897: **The app-API proxy refuses traversal-shaped paths.** A path in which a round of percent-decoding reveals a whole `.` or `..` segment — encoded twice, split by a tab, LF or CR (`.%2509.`), or behind an encoded separator h3 leaves encoded (`a%2F..%2Fb`, `a%5c..%5cb`) — answers `404`, so a chain of rewriting hops in front of the app cannot walk it onto lukk's routes.
- c1ca230: **BFF: the auth proxy strips a credential from a passed-through body at any depth.**
  
  The fail-closed deny-list that removes `access_token`, `refresh_token` and `confirmation_token` from a body the proxy returns stopped four levels down. A token nested any deeper, for example in a rebound response that wraps its payload in an envelope, reached the browser. That is the one thing BFF mode exists to prevent. The cap was there for cyclic bodies, but a parsed JSON body cannot be cyclic, and the work is linear in a body lukk already sent. lukk's own responses never nest a token that deep, so a stock install was not affected.
- dadc897: **No rotation is lost to a caller that stopped waiting, or to a request still carrying the old cookie.** Every rotation the BFF makes is journalled per session, as a link from the refresh token it consumed to the pair it produced. A request still presenting a consumed token — from the auth proxy's `/refresh` or 401 retry, the app-API proxy, or SSR hydration — is handed the newest pair in that chain and seals it, instead of replaying a spent token that lukk's reuse detection would answer with a family revoke once its grace window had passed. While the newest pair's own token is being rotated, such a request waits for that rotation and is handed what it produced. Its `expires_in` is what is left of the access token, counted from when lukk minted it (when the refresh left) — and so is the `expires_in` a caller receiving a slow refresh directly is given, which used to be lukk's figure as sent, overstating the token's life by however long the refresh took.
  
  Each link lives on its own: held ten minutes until its pair is delivered — until a response carrying it actually leaves, which for an app-API long-poll, a slow upload or a long render is well after the rotation landed — and 30 seconds from then, for the requests already out with the old cookie (so a hold lasts at most ten minutes and 30 seconds); it is also cut to 30 seconds when the rotation of the pair it handed out lands. After that a link's end is only ever brought forward, and never past the end of the link after it, so an old cookie is never handed a pair rotated since. And every caller re-checks the journal at the last moment before its cookie leaves — the auth proxy's retry as it seals, the app-API proxy when the upstream's headers arrive, SSR hydration once the page has rendered — sealing the newest pair if the session rotated the one it was handed meanwhile — or, when the session has moved past it and the links that led on are gone (for the app-API proxy and SSR, a response slower than the links' window; for the auth proxy, which gives up on lukk after 15 seconds, only a journal that overflowed meanwhile), withholding its session cookie so the browser keeps the newer one. For that, the BFF remembers each session's newest refresh token for five minutes after its last rotation, independently of the links, and forgets it when the session is logged out or replaced. A step-up confirmation answering on such a request is not recorded: the auth proxy answers `409` ("Your session was renewed meanwhile. Please confirm again.") and the user is asked to confirm again. A session that ends while a response is re-sealing has that seal dropped and its tokens revoked.
  
  Two deliberate trade-offs against a false logout, bounded to these windows: the journal can answer a replay up to ten minutes and 30 seconds after lukk rotated, for a rotation whose cookie never left (and a slow response's duration + 30 seconds, for one that left late) — past lukk's own grace window — and such a replay never reaches lukk, so its reuse detection and `RefreshFamilyForked` event do not see it (a deviation from RFC 9700 §4.14.2, which treats a replay as the sign of a stolen token). Outside the windows a replay reaches lukk as before. The journal is dropped when the session presents a token outside it, when lukk refuses one of its tokens outright, and when the session is logged out or replaced; a throttle or an outage keeps it. A refresh in flight is joined only by a request presenting the token it is rotating. At most 16 links per session. The journal is per process: a multi-instance BFF without sticky sessions does not share it.
  
  **A refresh waiting out a `Retry-After` stands down for a logout** instead of renewing the session being ended and holding the logout behind the wait.
- 945323e: **A server-side refresh is never cut short.** The 15-second upstream deadline also applied to the refresh, and aborting it after lukk had rotated the token lost the replacement: the session kept the consumed token, and its next refresh — past the grace window — was the replay reuse detection answers with a family revoke, a false logout. An abort cannot un-rotate a token, so the refresh now waits for lukk's answer, bounded only by the runtime's own transport timeouts; every request on a session shares that one call.
  
  **The deadline covers the response body, not only its headers.** A lukk that sent headers and then stalled the body held the auth proxy's request until the socket timed out; it now fails at the deadline as a `502`. The background revocation of a dropped session is bounded by the same deadline.
- 7bbaa3d: **A refresh the BFF asks to retry is retried.** `LukkError` gains `retryAfter`, the server's `Retry-After` in seconds. When the BFF answers a refresh with `503` and `Retry-After` — lukk is slow to rotate — lukk-nuxt's client waits that long (at most ten seconds) and asks once more, which joins the rotation still in flight or adopts it once it has landed, instead of reporting the session unavailable until the user's next action.
- 5862856: **A slow refresh no longer holds the requests waiting on it, and its result is never lost.** The rotation itself is still never aborted, but each caller now waits at most 15 seconds: the auth proxy's `/refresh` answers `503` with `Retry-After: 5` (keeping the session), a proxied or app-API call goes ahead with the old access token, and an SSR render leaves the session to the client. What it produces is journalled for the session's next request still presenting the consumed token (see the rotation-journal entry). A refresh that never settles stops being shared after five minutes, so a hung connection cannot wedge a session on a runtime with no transport timeout of its own, and none of these timers keeps the process alive.
  
  **The app-API proxy removes only the headers it blanked.** A header the browser itself sent with an empty value — `Accept` included, with `api.forceJson` off — is forwarded as sent, as RFC 9110 allows. **It refuses a route to lukk hidden behind a decoded `?` or `#`** (`/api/x%3F/%252e%252e/auth/login`). **A file name with a space in it is proxied again** — `/api/files/Annual%20Report.pdf` was refused as an encoded route to lukk, because the URL parser re-encodes a space and the double-decoding check never saw the path settle. Unread upstream bodies (a refused redirect, a refused refresh) are cancelled, releasing the connection.
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
- 16912a8: **A rotation's straggler window starts when its cookie leaves.** A link was given its 30 seconds when the rotation landed, but the app-API proxy and SSR deliver the cookie only when the upstream's headers arrive or the page renders — a long-poll or a slow upload left the browser on the consumed token after the window had closed, and its next refresh was revoked. Links are now held until a caller's cookie carrying their pair actually leaves — including on the error response when the upstream is unreachable (with the same checks: a session that ended meanwhile is withheld and revoked, a replaced logout's cookies withheld), and not when the browser has already gone as the response is about to leave (a navigation aborting an in-flight `/refresh`, a closed tab) — at every delivery point alike: the auth proxy's `/refresh`, 401 retry and step-up capture, the app-API proxy, and the end of an SSR render.
  
  **Step-up and `/refresh` seal the newest pair.** A step-up confirmation re-sealed the session's tokens as they arrived, even when another request had rotated them meanwhile; `/api/_lukk/refresh` sealed without re-checking. Both now seal the newest pair, and answer `409` for a pair the session has moved past.
  
  **A page render's own app-API requests never rotate the session** — the rotated cookie went back to the render, not the browser, which then replayed the consumed token. This covers Nuxt's own `useFetch('/api/…')`, `useRequestFetch()` and `event.$fetch` too: a BFF server plugin marks the page request itself (`x-lukk-ssr`, removed before the request reaches your API), so every request the render makes carries it. The BFF auth proxy honours the marker too (a marked request's `401` is passed through, a marked `/refresh` answers `401` without rotating; a logout still renews, to revoke). A render renews the session once, before it starts — through SSR hydration, or, with `ssrHydrate: false`, a renew-only step that loads no user and marks the render `no-store` — and that cookie leaves with the page, with the same last checks. With `ssrHydrate: false` an aged-out page load therefore rotates twice (the server's renewal, then the client's restore), and both count against lukk's refresh throttle. A server route's own `event.$fetch('/api/…')` is not marked; a route that needs the session reads it with `getLukkAccessToken`.
  
  **The app-API proxy refuses lukk's routes behind a PHP front controller** (`/api/index.php/auth/login`), which Laravel routes like `/auth/login` — any `.php` segment, so an app under a sub-path (`/app/index.php/auth/login`) too, and a `baseURL` that names the front controller itself (`https://host/index.php/auth`, Laravel without URL rewriting), and a script segment only a further decoding hop reveals (`/index.php%2Fauth/login`, `/index%252ephp/auth/login`). The path is judged as written and with the script segments dropped, so a `.php` segment never hides an encoded `/`, `?`, `#` or `..`. A tab, LF or CR that a re-parsing hop strips is stripped before the script segments are read, too (`/index.ph%2509p/auth/login`). Path checks cannot see how the backend maps URLs to its script (`SCRIPT_NAME`): where the front controller's directory is not in the public URLs (shared hosting rewriting into `public/index.php`, Symfony trimming a URI containing `index.php`), only an `api.target` host or prefix that does not serve lukk's routes contains them — the documented layout. **A refresh answer whose body breaks off** is an outage (`503`), not a `500` for every request sharing it.
- 945323e: **`session.maxAge` is validated.** It must be a positive whole number of seconds. `0` sealed every session with no expiry at all (iron reads a ttl of `0` as "never"), and a negative, fractional or non-numeric value wrote a cookie browsers drop or ignore. The build now fails with a message naming the option, and a runtime override that is not usable makes the session writers throw rather than seal anything weaker.
- 3e0b0eb: **Sign-in calls no longer refresh and retry on a 401.** `login`, `register`, `twoFactorChallenge` and `loginWithPasskey` don't authenticate with the current session, so a 401 from one is the server's answer — lukk returns it for a passkey whose user no longer exists — not an expired access token. Refreshing on it rotated the refresh token of the session being replaced and then sent the credentials, or an already-spent passkey ceremony, a second time. They now reject with the 401 directly: in lukk-core's client, and in lukk-nuxt's BFF proxy for `/login`, `/register`, `/two-factor-challenge` and `/passkeys/login`.
  
  `logout()` keeps its refresh-and-retry by default, and now accepts `{ retry: false }` for a binding that renews the token itself — lukk-nuxt does, so its refresh gate can't make a logout wait on its own renewal. It also sends an empty JSON body now (`Content-Type: application/json`) instead of none: lukk releases that end a session by its refresh cookie accept that only from a request a cross-site form couldn't have made, and the JSON body is that signal.
- 553dfbd: **A step-up header named after one the proxy or the transport already owns is refused: set in `nuxt.config` it fails the build, and a runtime override falls back to `X-Lukk-Confirmation` — instead of breaking step-up or the whole app API.**
  
  `confirmationHeader` is refused when it collides with a header the proxies set themselves, but that list was a hand-kept copy that had fallen behind the proxy. `via`, the `x-forwarded-prefix` family (`x-forwarded-server`, `-scheme`, `-ssl`, `-uri`, `x-original-url`, `x-rewrite-url`, …) and the sealed-session request header `x-<session cookie>-session` all passed validation. The app-API proxy then overwrote or blanked the server-held token on every request, so confirm-gated app routes failed with no error pointing at the setting. Names the transport refuses were accepted too: `connection`, `keep-alive`, `content-length` or `expect` made undici reject every proxied request with a 502, and in direct mode the browser silently drops Fetch's forbidden request headers. The list is now built from the map of headers the proxy blanks, plus the Fetch standard's forbidden names and the `Proxy-`/`Sec-` prefixes. A test checks every header the proxy actually sends.
- 945323e: **An unearnable step-up reaches the action waiting on it from another component.** The 403 that makes a step-up impossible was held per `useLukkConfirmation()` instance, so when the modal confirming and the page waiting in `withConfirmation()` were different instances — the usual shape — the page's action rejected as "cancelled" instead of with the 403. It is now held per app. **`$lukkRestore` is typed in templates**, like `$lukk` and `$lukkRefresh`.
- a6a1337: **A passkey sign-in overtaken by a logout ends its own session again.** Since a second `logout()` joins the one in progress, the passkey path's `logout()` for the session it had just been issued joined the logout that went out before that session existed, so the session stayed live: signed back in on the next BFF page load, orphaned upstream in direct mode. Passkey sign-in now completes through the same path as a password sign-in, which ends such a session with a logout of its own.
  
  **Repeated slashes no longer slip past the proxies' route checks.** `/api//auth/login` and `/api/_lukk//refresh` were read as distinct from their single-slash forms, while a slash-merging hop in front of Laravel (nginx's default) delivers them as `/auth/login` and `/auth/refresh`. Route checks now collapse them first.
  
  **The BFF auth proxy refuses a path lukk could not route as written.** A path with an interior empty segment, an encoded slash or backslash, or an encoded `%` (`/_lukk//logout`, `/_lukk/refresh%2F`, `/_lukk/logout%252f`) now answers 404 without reaching lukk. Route policy is decided on the path as lukk's router reads it, and such a path had the sealed refresh token injected into a request lukk never routed, so it could reach an app's fallback route. Trailing slashes are still accepted. The internal sign-in symbol moved out of `composables/`, which Nuxt auto-imports into every app.
- Updated dependencies [5f2ca8b]
- Updated dependencies [945323e]
- Updated dependencies [af8a72a]
- Updated dependencies [bdca3f2]
- Updated dependencies [ad1e1e5]
- Updated dependencies [b88797e]
- Updated dependencies [9f4be14]
- Updated dependencies [7bbaa3d]
- Updated dependencies [21953a7]
- Updated dependencies [16912a8]
- Updated dependencies [95c76f3]
- Updated dependencies [411d003]
- Updated dependencies [3e0b0eb]
  - lukk-core@0.12.0

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

### Patch Changes

- Updated dependencies [700b638]
- Updated dependencies [6d8ff9d]
  - lukk-core@0.11.0

## 0.10.1

### Patch Changes

- b705559: **Fixes a total outage of the app-API proxy introduced in 0.10.0.** Every proxied request returned `502` when the client sent a `Connection` header — which is every HTTP/1.1 client, and every deployment behind the standard nginx config.

  0.10.0 added RFC 9110 §7.6.1 handling: strip the headers a client names in `Connection`. The rule is right; the mechanism wasn't. Those names were neutralised by setting them to `""` on the outgoing fetch, and undici **refuses to set** `connection`, `keep-alive`, `upgrade` or `transfer-encoding` at all — blank or not. It throws `UND_ERR_INVALID_ARG` before the request leaves the process, and h3 turns that into an opaque `502` with the reason buried in `error.cause`.

  `Connection: keep-alive` is what an HTTP/1.1 client sends, and Nuxt's own deployment docs set `proxy_set_header Connection "upgrade"` unconditionally — so in practice almost every request carried one of the four.

  Those names are now skipped rather than blanked. Nothing is lost: `fetch` manages the connection itself and never forwards them regardless. Blanking still applies to everything else a `Connection` header can legitimately name, which is the case the feature exists for.

  Also logs the underlying cause when a proxy fetch fails — once per distinct target and cause, since an outage fails every request identically. The `502` was previously undiagnosable — an unreachable upstream and an illegal outgoing request looked identical — which is what made this cost a bisect rather than a glance at the logs.

  - lukk-core@0.10.1

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

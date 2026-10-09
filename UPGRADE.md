# Upgrade Guide

This guide lists every change across `lukk-core` and `lukk-nuxt` that **requires action on
upgrade** — a changed default, a renamed export, a config shape change, anything that can
surprise an existing install. For the full per-release detail (features, fixes), read each
package's changelog; this file is only the "you may need to do something" subset.

- [`lukk-core` CHANGELOG](packages/core/CHANGELOG.md)
- [`lukk-nuxt` CHANGELOG](packages/nuxt/CHANGELOG.md)

**lukk-js is pre-1.0 (`0.x`).** Per [SemVer §4](https://semver.org/#spec-item-4), a **minor**
bump (`0.x.0`) may carry a breaking change; a **patch** bump (`0.x.y`) never does. The two
packages version independently (this is a changesets monorepo), so check the changelog for the
package you actually depend on. Each entry below is tagged **High / Medium / Low impact**.

Because lukk-js only ever *speaks* [lukk](https://github.com/stsepelin/lukk)'s HTTP contract,
a server upgrade can also require a client change (or vice-versa) — when it does, the entry
links the matching [lukk `UPGRADE.md`](https://github.com/stsepelin/lukk/blob/main/UPGRADE.md)
section. Upgrade the server first; it's the source of truth.

**Impact key** — _High_: action required or the client will break. _Medium_: action required
only if you use the named feature/mode. _Low_: informational; a behavior changed but the
default is safe.

---

## Upgrading to `lukk-nuxt` 0.12.0 / `lukk-core` 0.12.0 (unreleased)

Everything before this release was additive. This one is not. No runtime API was renamed or removed,
but behaviour changed in ways an app can notice even without typechecking:

- passkey sign-in can return a two-factor challenge, and the `amr` values changed (lukk 0.7);
- the proxies refuse more — lukk's own routes through the app-API proxy, oversized and unsized bodies,
  cross-site subresource requests to either proxy, any `/refresh` but a POST — and sealed sessions
  expire;
- in BFF mode `$lukkRefresh()` resolves to a symbol rather than `{ ok, expires_in }`;
- SSR forwards cookies only to a relative API base, and `useLukkForm` drafts moved keys;
- `useLukkFetch` sends credentials only to a target it has judged same-origin, so a call that replaces
  its `onRequest` hook or points it at another origin goes out without them.

The published type declarations also stopped lying, which can fail a typecheck that passed before, and
one route-middleware decision changed. Each is its own entry below.

### lukk 0.7: passkey sign-in can return a two-factor challenge, and `amr` changed values

**Medium impact — if you use passkeys with two-factor, or read `amr`.**

`useLukkPasskeys().login()` now resolves to a `LoginResult`. When lukk answers a single-factor
passkey with a two-factor challenge, `pendingTwoFactor` turns true and no user is loaded: show the
same code form as after a password sign-in. `confirm()` asks the new
`POST /auth/confirm-passkey/options` and falls back to the login options on a 404. The `Amr` type is
now `'pwd' | 'otp' | 'pop' | 'user' | 'mfa'`; anything comparing against `'webauthn'` must move to
`'pop'`, or to `'mfa'` for "was this multi-factor".

### The proxies refuse more, and seals expire

**Low impact — check if you relied on the old behaviour.**

- The app-API proxy answers **404** for any target under lukk's own base path, so lukk's routes are
  reachable only through the auth proxy and its route policy.
- The BFF auth proxy caps request bodies at the new `bodyLimit` (1 MiB): over it is **413**, and a
  chunked body without a length is **411**.
- Sealed sessions carry a lifetime, the new `session.maxAge` (30 days). A seal written before this
  release has none until it is next re-sealed.
- In direct mode, SSR forwards the visitor's cookies only to a relative API base. An absolute API
  no longer receives them; send what it needs explicitly.
- `useLukkForm` drafts live under `lukk:form:<rememberKey>`, so a draft remembered under the old key
  is not carried over.
- The BFF session cookie now persists for `session.maxAge` (30 days) instead of ending with the
  browser, so BFF users stay signed in across restarts, as direct-mode users already did.
- A `withConfirmation()` still waiting for a step-up is cancelled — it rejects — when the session ends
  by logout or when any sign-in replaces it, so its action can no longer run under the next account.
- In BFF mode, `$lukkRefresh()` resolves to the `REFRESHED_WITHOUT_TOKEN` symbol instead of the
  proxy's `{ ok, expires_in }`; code reading `.expires_in` from it gets `undefined`. Both are truthy on
  success. `$lukkRestore()`'s `pair` carries the same symbol.
- Every BFF auth-proxy response carries `X-Content-Type-Options: nosniff`, and a non-JSON upstream body
  goes out as `text/plain`.
- Route checks collapse repeated slashes, so `/api//auth/login` is refused like `/api/auth/login`.
- The app-API proxy also refuses a path that a further round of percent-decoding would turn into one
  of lukk's routes (`/api/x/%252e%252e/auth/login`, `/api/%2561uth/login`) with **404**.
- Both proxies refuse a cross-site or same-site GET that is not a **top-level** navigation with **403** —
  the app-API proxy now too, and a navigation into an `<iframe>`, `<frame>`, `<embed>` or `<object>` no
  longer counts as one. A link the visitor follows still works.
- `/api/_lukk/refresh` answers anything but `POST` with **405** and `Allow: POST`.
- App-API proxy responses carry `X-Content-Type-Options: nosniff`, and every response that is neither
  JSON nor a PDF also carries `Content-Security-Policy: sandbox` (added to the upstream's own policy), so
  an HTML or SVG document from your API renders without script and outside the app's origin. Serve such
  documents from another origin if they need to run script.
- Request headers the app-API proxy strips (`Origin`, `Cookie`, spoofable forwarding headers, anything
  the client named in `Connection`) are now removed rather than forwarded empty.
- `session.maxAge` must be a positive whole number of seconds: anything else fails the build, and a
  runtime override that is not one makes every write of the session throw.

### `useLukkFetch` sends credentials only where it has checked they belong

**Medium impact — if you pass your own `onRequest` to `useLukkFetch()`, or a per-call `baseURL`.**

The instance used to default to `credentials: 'include'` and narrow it in its own `onRequest` hook.
ofetch merges per-call options by spreading, so a call passing its own `onRequest` **replaced** that
hook and kept `include` — sending the visitor's cookies to wherever the call pointed. The default is now
`'same-origin'`, upgraded to `include` (and the bearer attached) only once the target is known to be on
the API's origin. The same decision now also looks at a per-call `baseURL`: an absolute one is honoured
only on the API's own origin (or this app's, in BFF mode).

What changes for you: a call that replaces the hook, or that redirects the base to another origin, now
goes out **without** the session cookie or bearer and gets a `401`. Wrap lukk's instance instead of
replacing its hook, and keep authenticated calls on the API's origin.

### Smaller changes you may notice

**Low impact.**

- **The account calls resolve to `{ status }`.** `forgotPassword`, `resetPassword`, `changePassword` and
  `sendEmailVerification` resolved to `void` in the types; they resolve to the new exported `LukkStatus`
  (`{ status: string }`), which is what lukk always sent. Code that ignored the result is unaffected.
- **`logout({ refreshToken })` (lukk-core).** Presents the refresh token in the logout body, so lukk 0.7
  ends the session even when the access token has expired (RFC 7009 §2.1). Optional; older lukk
  releases ignore it.
- **In BFF mode `user.endpoint` resolves under `app.baseURL`**, like every other BFF route. An app mounted
  under a base path that worked around this with an absolute endpoint can drop the workaround. **Action
  needed** if it worked around it with a base-prefixed RELATIVE endpoint instead — `user.endpoint:
  '/admin/api/me'` under `app.baseURL: '/admin/'` now resolves to `/admin/admin/api/me` and 404s, which
  signs everyone out on load. Drop the prefix: `user.endpoint: '/api/me'`.
- **Direct mode no longer prefixes a relative `api.target` with `app.baseURL`** in `useLukkFetch`. The
  prefix came in earlier in this release cycle and never shipped; only a direct-mode app tracking the
  branch would notice.
- **A refresh is never abandoned on a timer.** lukk commits a rotation as soon as it receives the
  request, so giving up after 15 s lost the new token and the next refresh past the grace window revoked
  the whole session. Other upstream calls keep the 15 s deadline, which now also covers reading the body.
  A request is still not held on a slow refresh: after 15 s `/api/_lukk/refresh` answers `503` with
  `Retry-After: 5` (the session is kept), and the retry joins the refresh still in flight.
- **An unearnable step-up is remembered per app**, not per `useLukkConfirmation()` call: a modal and a
  page using separate instances now both see the refusal, and the action waiting in one is rejected.

### Every composable now declares its return type

**High impact — if you run `vue-tsc` / `nuxi typecheck`.**

The published declarations typed most composable members `any`, so an assignment to internal
state, or a property that doesn't exist, type-checked. `useLukkAuth()` now returns `LukkAuth`,
and `useLukkAbilities`, `useLukkAccount`, `useLukkChangePassword`, `useLukkConfirmation`,
`useLukkEmailVerification`, `useLukkPasskeys`, `useLukkPasswordReset` and `useLukkTwoFactor`
each return their own declared type; `useLukkFetch()` is `$Fetch`, and `LukkForm<T>` marks its
derived members `readonly`.

Three things start failing, all of them code that was already wrong:

- **`user` is `Ref<LukkUser | null>`**, and `LukkUser` declares only what lukk itself knows
  about — so `user.value.name` fails, and so does `user.value?.name`. Augment it with your own
  user shape, once, anywhere in your app:

  ```ts
  declare module 'lukk-core' {
    interface LukkUser {
      name: string
      avatar_url: string | null
    }
  }
  ```

- **Assigning to derived state.** `loggedIn`, `useLukkConfirmation().required` and `.token`, and
  a form's `processing` / `data` are computed or internal; write through the composable's own
  methods instead.
- **Values that used to be `any`** now carry a real type at the call site, so a mismatch that
  was silently accepted surfaces where it is.

### `LukkAuth` is auto-imported as a global type

**Medium impact — if your app declares a type of the same name.**

`LukkAuth` (and the other composable return types) are registered as global types, so an app
type called `LukkAuth` now clashes. Rename yours, or import it explicitly under an alias where
you use it.

### `PasskeySummary.last_used_at` is a number, not a string

**Low impact — if you read that field.**

`GET /auth/passkeys` has always returned a unix timestamp here; the declaration said `string`.
Code that formatted it as a date string was already producing the wrong output at runtime, and
now fails to typecheck. `AccountExport` also gains an optional `lockouts` array, for lukk
releases that include the [account-lockout](https://stsepelin.github.io/lukk-docs/account-lockout)
counters in the export.

### `lukk-auth` can render a protected page for a visitor it couldn't identify

**Medium impact — behaviour change; no action if your API enforces access.**

`lukk-auth` used to redirect whenever `loggedIn` was `false`, which included a server render
that couldn't resolve the session — sending a signed-in visitor to `/login` before their client
had restored them. It now defers while `ready` is `false`, and doesn't redirect when
`restoreFailed` is `true` so the page can offer a retry. The consequence is that a protected
page can render for a visitor the server couldn't identify, before the client redirects them.
Route middleware isn't access control; your API is. Never put protected data in the page from
anything but an authenticated API response.

### Sign-in calls no longer refresh and retry on a `401`

**Low impact — informational.**

`login`, `register`, `twoFactorChallenge` and `loginWithPasskey` don't authenticate with the
current session, so a `401` from one is the server's answer (lukk returns it for a passkey whose
user no longer exists), not an expired access token. They now reject with it directly, in
lukk-core's client and in lukk-nuxt's BFF proxy. Refreshing on it rotated the refresh token of
the session being replaced and then re-sent the credentials, or an already-spent passkey
ceremony. `logout()` keeps its refresh-and-retry, and accepts `{ retry: false }` for a binding
that renews the token itself.

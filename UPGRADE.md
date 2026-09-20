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

Everything before this release was additive. This one is not: the published type declarations
stopped lying, which can fail a typecheck that passed before, and one route-middleware decision
changed. No runtime API was renamed or removed, so an app that doesn't typecheck its own code
has only the middleware entry to read.

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

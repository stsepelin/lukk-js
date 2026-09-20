---
"lukk-nuxt": minor
---

**`useLukkAuth().ready`, `whenReady()` and `restoreFailed`** — tell "not resolved yet" and "couldn't reach the server" apart from "anonymous".

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

Sign-ins (password, register, two-factor, passkey) are now a session handover. They wait for a refresh already in flight before sending — at most 10 seconds, so a refresh that never answers cannot lock anyone out — and a refresh that starts while one is on the wire waits for it, then isn't sent at all if a new session began. `logout()` waits for an in-flight refresh the same way, authenticates with the token it minted, and holds back a refresh that starts while it is out. When lukk rejects its access token (an idle user whose token expired, an erased account), `logout()` renews the token itself and retries once, rather than through lukk-core's own retry — whose refresh would wait on that same logout for the full 10 seconds. That renewal is one more round trip, so **await `logout()` before navigating away**. It can reject after clearing local state: a `401` means there was no session left, anything else (a network failure, a throttled logout) that it may still be live — offer a retry there rather than navigating on. And a full page load that cancels the renewal leaves the session unrevoked (in direct mode; the BFF renews server-side). A sign-in also waits for a logout still running in the same tab, including the gap while it renews its token, whose cleanup and cleared cookie otherwise landed after the new session and signed it out; and a user reload the renewal started can no longer land after the logout and sign the user back in.

A tab that signs in or logs out now tells the app's other open tabs through a `BroadcastChannel` (where the browser has one). They drop what they had in flight and re-check — a BFF tab reloads its user, a direct tab renews from the shared cookie first — instead of showing an account the browser no longer holds while their requests act as another. (Across tabs, sign-ins, logouts and refreshes also queue behind a Web Lock — see the session-gaps entry.) A sign-in that issues a session, and every `logout()` before it sends its request, starts a new session generation; a refresh, restore or `fetchUser()` from an older one discards its result instead of writing it. A sign-in that answers after a `logout()` ends the session it was issued rather than signing in. One that started no session (rejected credentials, a two-factor challenge, a registration awaiting verification) changes nothing.

The wait is capped, so in direct mode a refresh slower than 10 seconds can still land its cookie after the new session's. The BFF proxy closes the rest on the server — see the next entry.

Also fixed: after `clearNuxtState()`, an existing `useLukkAuth()` read `loggedIn` and `pendingTwoFactor` as `true`. And `useLukkAuth()` now has a declared return type, `LukkAuth` — the published declarations typed `user`, `loggedIn` and `pendingTwoFactor` as `any`, so an assignment to them type-checked. **This can fail a typecheck that passed before:** `user` is now `Ref<LukkUser | null>`, and `LukkUser` declares only what lukk knows about — so `user.value.name` fails, and so does `user.value?.name`, until the app augments it (`declare module 'lukk-core' { interface LukkUser { name: string } }`). An assignment to `loggedIn` fails too. `LukkAuth` is also auto-imported as a global type, so an app type of the same name now clashes. The other composables (`useLukkConfirmation`, `useLukkAbilities`, `useLukkTwoFactor`, `useLukkPasskeys` and more) still publish `any` fields.

Deliberate limits:

- **An anonymous server render is never marked `ready`.** It isn't `no-store`, so a shared cache may serve it to a signed-in visitor whose cookie the edge ignored — and a baked-in `ready: true` would stop that visitor's client from restoring. Only a hydrated, per-user, `no-store` render carries it.
- **`whenReady()` resolves immediately on the server**, whatever `ready` says: the client restore never runs there, and waiting would hang the render. Read `ready` afterwards in code that also runs on the server.
- **Reading `ready` in a template on a server-rendered page causes a hydration mismatch** when the server didn't hydrate a user; `restoreFailed` does when the client restore then fails. Use them in logic, or inside `<ClientOnly>`.
- **A plugin that awaits `whenReady()` in its setup must run after the restore** — put it in a `.client.ts` file with `dependsOn: ['lukk:session-restore']`. The restore plugin is client-only, so a universal plugin naming it is reported (logged as an error during the build on Nuxt 3 and earlier 4.x releases, which still succeeds; only a development warning on recent Nuxt 4). Awaiting it earlier can deadlock startup, and depending on `lukk:client` doesn't prevent that; this is warned about in development.
- **`ready` survives `clearNuxtState()`**, a common logout idiom, which would otherwise leave every later `whenReady()` pending. `restoreFailed` does not: it reads as `false` afterwards until the next restore.

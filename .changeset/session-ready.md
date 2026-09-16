---
"lukk-nuxt": minor
---

**`useLukkAuth().ready`, `whenReady()` and `restoreFailed`** — tell "not resolved yet" and "couldn't reach the server" apart from "anonymous".

`loggedIn: false` meant both, so a redirect, a fetch of account-scoped data, or a deep-link restore could act on an unresolved session and silently do the wrong thing, with nothing to retry on. `ready` becomes `true` once the session has been resolved either way; `whenReady()` resolves at that moment.

```ts
const { ready, loggedIn, whenReady } = useLukkAuth()

onMounted(async () => {
  await whenReady()
  if (!loggedIn.value) return navigateTo('/login')
  // …restore the deep link
})
```

**Where the gap actually is.** Nuxt awaits the `lukk:session-restore` plugin before the initial navigation and before mounting, so on the client, route middleware, `setup()` and `onMounted` already see the session resolved. The gap is the **server render** when it did not hydrate a user — direct mode, `ssrHydrate: false`, prerendered routes, or a session the server couldn't rotate. There `loggedIn` is `false` because the server cannot tell, and a `useAsyncData` that skipped on it baked an empty result into the payload that hydration never re-ran. `ready` is `false` in exactly those renders, so code can defer to the client instead.

`ready` is `true` from the first line when the server hydrated the user, so that path stays synchronous, and nothing changes for an app that doesn't read it.

Two deliberate limits:

- **An anonymous server render is never marked `ready`.** It isn't `no-store`, so a shared cache may serve it to a signed-in visitor whose cookie the edge ignored — and a baked-in `ready: true` would stop that visitor's client from restoring. Only a hydrated, per-user, `no-store` render carries it.
- **`whenReady()` resolves immediately on the server**, whatever `ready` says: nothing later in the request can resolve the session, and waiting would hang the render. Read `ready` afterwards in code that also runs on the server.

**`restoreFailed`** separates a restore that reached no answer from a real signed-out visitor. Only a 401/403 means "no session" — the rule `fetchUser` already used. A throttled refresh (429), a server error (5xx, including the BFF's 503), an unreachable server, or a user endpoint that fails right after a successful refresh now sets `restoreFailed` instead of silently reading as anonymous, so an app can offer a retry rather than a login form. `initSession()` is the retry and updates the flag either way; it is hidden while someone is signed in and cleared by `logout()`.

It is read through a restore-specific variant of the SAME single-flight refresh, so a boot restore still cannot race a request's own 401 retry and replay the rotating refresh token.

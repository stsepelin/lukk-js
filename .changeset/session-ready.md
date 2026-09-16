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

It is `true` from the first line when the server hydrated the user, so that path stays synchronous, and nothing changes for an app that doesn't read it.

**`restoreFailed`** separates a restore that reached no answer from a real signed-out visitor. Only a 401/403 means "no session" — the rule `fetchUser` already used. Anything else sets it: a throttled refresh (429), a server error (5xx, including the BFF's 503), an unreachable server, a user endpoint that fails right after a successful refresh — and a misconfigured endpoint, where retrying cannot help. `initSession()` is the retry. The flag is cleared by every definitive answer (a user loaded, a 401/403, `logout()`), and a `logout()` during an in-flight restore wins over that restore's result.

It is read through a restore-specific variant of the SAME single-flight refresh, so a boot restore still cannot race a request's own 401 retry and replay the rotating refresh token.

Deliberate limits:

- **An anonymous server render is never marked `ready`.** It isn't `no-store`, so a shared cache may serve it to a signed-in visitor whose cookie the edge ignored — and a baked-in `ready: true` would stop that visitor's client from restoring. Only a hydrated, per-user, `no-store` render carries it.
- **`whenReady()` resolves immediately on the server**, whatever `ready` says: nothing later in the request can resolve the session, and waiting would hang the render. Read `ready` afterwards in code that also runs on the server.
- **Reading `ready` or `restoreFailed` in a template on a server-rendered page causes a hydration mismatch** when the server didn't hydrate a user. Use them in logic, or inside `<ClientOnly>`.
- **A plugin that awaits `whenReady()` in its setup must run after the restore** — give it `dependsOn: ['lukk:session-restore']`. Awaiting it earlier deadlocks startup; this is warned about in development.
- **Readiness survives `clearNuxtState()`**, a common logout idiom, which would otherwise leave every later `whenReady()` pending.
- **The built-in `lukk-auth` middleware does not use `ready` yet** and still redirects during a server render that couldn't resolve the session.

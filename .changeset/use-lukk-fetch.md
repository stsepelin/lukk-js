---
"lukk-nuxt": patch
---

Add `useLukkFetch()` — an auth-aware fetch for your **own** app API, in every context and both transport modes.

Plain `$fetch('/api/...')` in an SSR/server context forwards no cookie, so it silently 401s against an authenticated API. `useLukkFetch()` is transport-aware and gets this right:

- **BFF**: same-origin to the proxy mount; on SSR it forwards **only** the sealed session cookie (never `authorization`/`x-forwarded-*`), and the proxy injects the bearer.
- **direct**: attaches the in-memory bearer and single-flights a 401 refresh-and-retry — sharing `$lukk`'s one refresh, so the rotating token is never replayed (which reuse detection would punish with a family revoke).

It always sends `Accept: application/json`, uses `redirect: 'manual'` (an upstream 3xx becomes an external navigation rather than being silently followed), and rejects with a typed `LukkError` (`{ message, status, errors }`) so a Laravel 422 bag is ergonomic. Pair it with `getLukkAccessToken(event)` in a server route.

Credentials are attached **only** to a same-origin-as-baseURL target — a cross-origin URL passed to `useLukkFetch` gets no cookie/bearer and `credentials: 'same-origin'` (mirrors lukk-core's guard). The boot session-restore now goes through the same single-flight, so it can't race a concurrent app-API 401 refresh.

Additive and opt-in; the module also exposes `$lukkRefresh` (the shared single-flight refresh) on the Nuxt app.

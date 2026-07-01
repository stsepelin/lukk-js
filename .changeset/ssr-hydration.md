---
"lukk-nuxt": minor
---

BFF SSR auth hydration (on by default). In BFF mode the server now seeds `useLukkAuth().user` / `loggedIn` per request from the sealed session, so authenticated pages render logged-in on the first paint — no logged-out→logged-in flash and no consumer `<ClientOnly>`. A `session.server` plugin reads the sealed session read-only, and (when the access token is still valid) fetches your `user.endpoint` in-process via the same request-aware path `useLukkFetch` uses, seeding the user into the SSR payload; the client then skips the redundant restore.

Security: only the app `user` resource enters the payload — the access/refresh token never leaves the server; a hydrated render is marked `Cache-Control: no-store` so a shared cache can't cross-serve it; prerendered/cached pages and anonymous/expired-at-SSR sessions fall back to the client restore (never a mid-render token rotation, never a minted cookie, never a 500). `direct` mode is unaffected (no server session). Opt out with `lukk: { ssrHydrate: false }`.

**Behavior change:** SSR `useLukkAuth().user` was previously always `null` (populated only after client hydration); it is now populated during SSR in BFF mode. Review any page that special-cased "always anonymous on the server."

---
"lukk-nuxt": patch
---

Fix a BFF SSR auth flash on a full page load whose access token has aged out. The SSR-hydration plugin previously bailed on an expired access token and deferred to the client restore, so an authenticated hard refresh / redeploy / dev full-reload briefly rendered `/login` before the client corrected it.

`session.server` now resolves the hydration token through a new `resolveHydrationAccess(event)` helper: when the access token is expired but the session is still refreshable, it rotates once (via `refreshOnce`) and re-seals **in place**, writing the fresh seal onto **both** the page response (so the browser receives the rotated cookie) **and** the in-process request cookie — so the same render's `fetchUser` forwards the already-rotated session and the app-API proxy injects the new access token instead of rotating the just-consumed refresh token a second time (a replay lukk's reuse detection would answer with a whole-family revoke). A still-valid token seeds unchanged; an anonymous or unrefreshable session mints nothing and defers to the client. The render is marked `Cache-Control: no-store` as soon as a session is resolved (not gated on the user seeding), so a rotated cookie is never left cacheable.

SSR-only, BFF mode; no public API change. (The related http-dev cookie-name divergence was already fixed in 0.5.0 — upgrade to ≥ 0.5.0 if you still see the flash on a fresh login.)

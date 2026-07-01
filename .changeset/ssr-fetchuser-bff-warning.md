---
"lukk-nuxt": patch
---

Fix `useLukkFetch` in SSR, plus two related correctness fixes.

- **`useLukkFetch` now works during SSR in BFF mode.** Its base is the relative proxy mount (`/api`), which a plain `ofetch` cannot fetch server-side (Node's `fetch` needs an absolute URL → "Failed to parse URL"). On the server in BFF mode, calls now route through Nuxt's request-aware fetch (`useRequestFetch`), which resolves the relative URL **in-process** and forwards the session cookie to our own proxy — with no `Host`-derived absolute URL (so no SSRF) and no network egress. The auth-aware options (JSON, `redirect: 'manual'`, same-origin guard, typed `LukkError`, single-flight refresh) are shared between this path and the client/direct ofetch instance.
- **`useLukkAuth().fetchUser()`** loads the current user through `useLukkFetch` (SSR-authenticated) instead of a bare `$fetch`, which forwarded no cookie server-side and produced a silent 401 / logged-out flash.
- The Nuxt module now **warns at build** when the app-API proxy is half-configured — `api.path` set without `api.target` (or vice versa); it's only registered when both are present.

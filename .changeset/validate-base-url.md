---
"lukk-nuxt": minor
---

Validate `baseURL` / `api.target` at module setup, and stop reporting a misconfigured base as `"Invalid path."`.

A `baseURL` like `"undefined/auth"` — the classic result of an unset build-time env var interpolating into a template string — is a non-empty string, so the old falsiness check accepted it. It then failed at *request* time with `400 { "message": "Invalid path." }`, which describes the wrong fault: the path was fine, the `baseURL` wasn't. The value is compiled into the bundle, so it's knowable at build.

**Build-time validation**

- Setup now **fails the build** on a `baseURL`/`api.target` that isn't a valid absolute URL, naming the offending value (with any `user:pass@` masked) and the likely cause. It also catches a base that merely forgot its scheme: `new URL('localhost:3000/auth')` *succeeds* (parsing `localhost:` as the scheme), so the check requires `http:`/`https:`, not just a parse.
- A base carrying a **query or fragment** is rejected too. The request path is appended *after* it, so `/auth?t=1` + `/login` resolves to `/auth?t=1/login` — every route silently hits the same upstream endpoint, including `/logout`, which would clear the local session while the refresh-token family stays live at lukk.
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

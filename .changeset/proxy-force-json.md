---
"lukk-nuxt": patch
---

The BFF app-API proxy now sets `Accept: application/json` on forwarded requests by default (`api.forceJson`, default `true`).

This fixes the "confusing 500" on unauthenticated/validation errors. The proxy strips the browser's `Accept` (h3 behaviour), so without this Laravel's default `redirectGuestsTo(fn () => route('login'))` makes `Authenticate` eagerly resolve `route('login')` *inside the middleware* → `RouteNotFoundException` (a 500) — which `shouldRenderJsonWhen` can't prevent (it runs after the middleware already threw). Forcing JSON makes `expectsJson()` true, so unauthenticated/validation failures render clean `401`/`422` JSON with **no `bootstrap/app.php` change**.

Opt out with `api: { forceJson: false }` to forward the browser's `Accept` instead — only if a route under `path` legitimately serves a non-JSON response.

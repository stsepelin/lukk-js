---
"lukk-nuxt": minor
---

**`useLukkFetch` keeps the visitor's cookies on your app.** During SSR it forwarded every cookie the browser sent your app — analytics, CSRF, a co-hosted app's session — to the API base, which in direct mode is usually another host (`api.example.com`). The API's own cookies never reach your app's server in direct mode, so this sent that host everything except what it owns. The visitor's cookies now go only to the app itself (the BFF proxy mount); an absolute API base gets none. If your direct-mode SSR relied on cookies reaching the API, make that call from the browser or from a server route.

**It no longer trusts the request's `Host` on the server.** The app's own origin, used to accept an absolute URL that spells out the BFF mount, came from `Host` / `X-Forwarded-*` during SSR, so an absolute URL on a host the request named was treated as this app and sent the sealed session. On the server an absolute URL is now never "this app"; use a path.

**It keeps your `Accept`.** `Accept: application/json` is set only when you didn't set one, so a non-JSON route behind `api.forceJson: false` is reachable through it.

**The SSR BFF instance is a real `$Fetch`.** `.raw`, `.create` and `.native` were undefined during SSR (a bare function cast to the type), and a `Request` argument threw; all now work, with the same credential rules as a plain call.

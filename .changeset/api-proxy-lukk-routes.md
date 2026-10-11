---
"lukk-nuxt": minor
---

**The app-API proxy refuses lukk's own routes.** In the documented layout — `api.target` is your Laravel app and `baseURL` is the same app under `/auth` — `POST /api/auth/login` from any same-origin script was proxied to lukk and its `{ access_token, refresh_token }` streamed straight to the browser, and `/api/auth/confirm-password` handed back the step-up token: exactly what BFF mode exists to keep server-side. A request whose upstream URL falls under lukk's base path now answers 404, decided on the resolved URL the way Laravel's router reads it (dot segments collapsed, trailing slash trimmed, `%2F` and other escapes decoded, case-insensitively), and regardless of host, since the same app is often configured under a public name for `api.target` and an internal one for `baseURL`. When lukk is mounted at the root of the same host as `api.target` there is no path that tells the two apart, so the app-API proxy refuses everything; move lukk under a prefix or onto its own host. An unresolvable `baseURL` now fails the app-API proxy closed with a 500 naming the setting.

If your client called lukk's routes through `/api/...`, call them through the composables (the `/api/_lukk` auth proxy) instead.

**It also forwards the request target as sent and varies by Cookie.** h3 percent-decodes `event.path` before the handler runs, so an encoded `?` or `#` in a path segment (`/files/a%3Fb`) became a real query or fragment on the way upstream; the query now comes from the raw request and the path's `?`/`#` stay encoded. Responses now carry `Vary: Cookie` (merged with the upstream's own `Vary`) alongside `private, no-store`, as the auth proxy's already did.

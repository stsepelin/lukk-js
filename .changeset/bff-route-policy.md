---
"lukk-nuxt": minor
---

**The BFF auth proxy decides its route rules on the URL lukk will receive.** It compared the raw request path to `'/refresh'`, `'/logout'` and the sign-in routes as strings, while the upstream URL collapses dot segments and Laravel trims a trailing slash — so `/api/_lukk/./refresh`, `/refresh/` and `/a/../refresh` reached lukk's refresh route as an ordinary proxied call (the never-proxy-refresh rule bypassed), a sign-in spelled that way was refreshed and retried on a 401, and a logout spelled that way didn't clear the cookie. Every rule now reads the route the way Laravel's router does. An encoded `#` or `?` in the path (`%23`, `%3F`) now stays path data instead of becoming a fragment or query on the way upstream.

**Its responses say what they are.** A non-JSON upstream body (a WAF or proxy error page, say) went out as `text/html` on your app's origin; it is now `text/plain; charset=utf-8`, JSON is labelled `application/json; charset=utf-8` (a bare JSON string or `null` keeps its JSON form instead of becoming HTML or a 204), and every response carries `X-Content-Type-Options: nosniff`.

**It bounds the request body.** The body is buffered before anything else, on routes reachable unauthenticated. A declared `Content-Length` over the new `bodyLimit` option (default 1 MiB) now answers `413` before anything is read, a chunked body — which declares no length — answers `411`, and the bytes are measured again once read. The app-API proxy streams and is unaffected.

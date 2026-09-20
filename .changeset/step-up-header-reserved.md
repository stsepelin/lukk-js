---
"lukk-nuxt": patch
---

**A step-up header named after one the proxy or the transport already owns now falls back to `X-Lukk-Confirmation`, instead of breaking step-up or the whole app API.**

`confirmationHeader` is refused when it collides with a header the proxies set themselves, but that list was a hand-kept copy that had fallen behind the proxy. `via`, the `x-forwarded-prefix` family (`x-forwarded-server`, `-scheme`, `-ssl`, `-uri`, `x-original-url`, `x-rewrite-url`, …) and the sealed-session request header `x-<session cookie>-session` all passed validation. The app-API proxy then overwrote or blanked the server-held token on every request, so confirm-gated app routes failed with no error pointing at the setting. Names the transport refuses were accepted too: `connection`, `keep-alive`, `content-length` or `expect` made undici reject every proxied request with a 502, and in direct mode the browser silently drops Fetch's forbidden request headers. The list is now built from the map of headers the proxy blanks, plus the Fetch standard's forbidden names and the `Proxy-`/`Sec-` prefixes. A test checks every header the proxy actually sends.

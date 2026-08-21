---
"lukk-nuxt": patch
---

**Fixes a total outage of the app-API proxy introduced in 0.10.0.** Every proxied request returned `502` when the client sent a `Connection` header — which is every HTTP/1.1 client, and every deployment behind the standard nginx config.

0.10.0 added RFC 9110 §7.6.1 handling: strip the headers a client names in `Connection`. The rule is right; the mechanism wasn't. Those names were neutralised by setting them to `""` on the outgoing fetch, and undici **refuses to set** `connection`, `keep-alive`, `upgrade` or `transfer-encoding` at all — blank or not. It throws `UND_ERR_INVALID_ARG` before the request leaves the process, and h3 turns that into an opaque `502` with the reason buried in `error.cause`.

`Connection: keep-alive` is what an HTTP/1.1 client sends, and Nuxt's own deployment docs set `proxy_set_header Connection "upgrade"` unconditionally — so in practice almost every request carried one of the four.

Those names are now skipped rather than blanked. Nothing is lost: `fetch` manages the connection itself and never forwards them regardless. Blanking still applies to everything else a `Connection` header can legitimately name, which is the case the feature exists for.

Also logs the underlying cause when a proxy fetch fails — once per distinct target and cause, since an outage fails every request identically. The `502` was previously undiagnosable — an unreachable upstream and an illegal outgoing request looked identical — which is what made this cost a bisect rather than a glance at the logs.

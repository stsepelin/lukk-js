---
"lukk-nuxt": patch
---

**The app-API proxy keeps the app origin's CORS policy its own.** It passed the upstream's `Access-Control-*` response headers through and forwarded the browser's `Origin`, so an upstream that echoes `*.example.com` with credentials let a sibling subdomain read authenticated GETs, the bearer injected by the proxy. CORS response headers, and the upstream's hop-by-hop headers (RFC 9110 §7.6.1), are now dropped, and `Origin` is blanked upstream.

**The BFF auth proxy refuses a cross-site or same-site GET that is not a navigation.** A sibling's `<img src="/api/_lukk/account/export">` was answered with the sealed session and confirmation token, spending the user's step-up throttle. Top-level navigations, such as a link in an email, still pass.

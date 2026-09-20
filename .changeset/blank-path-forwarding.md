---
"lukk-nuxt": patch
---

**The app-API proxy now blanks the path and scheme forwarding headers a browser can set, not only the address ones.**

`X-Forwarded-Prefix`, `X-Forwarded-Scheme`, `X-Forwarded-SSL`, `X-Forwarded-URI`, `X-Original-URL` and `X-Rewrite-URL` used to reach your API as the browser sent them. Symfony and Laravel honour a trusted proxy's `X-Forwarded-Prefix` and apply it to the base path of every URL the app generates, so a browser-set value rewrote the links the app renders and emails. The others are the same idea through other front ends; `X-Original-URL`/`X-Rewrite-URL` have repeatedly been used to reach paths a front-end ACL believed it blocked. They now reach the API blank, like `X-Real-IP` and the rest of the forwarding set. If your API relied on one of them arriving from the browser through the proxy, that no longer happens; one set by your own edge in front of Nuxt is unaffected.

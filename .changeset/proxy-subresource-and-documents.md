---
"lukk-nuxt": minor
---

**The app-API proxy refuses cross-site subresource GETs too.** It injects the bearer from the sealed session, and only checked the origin of state-changing requests — so a same-site sibling's `<img src="/api/export">`, or another site's frame, was answered as the visitor. It now refuses them with `403`, as the auth proxy does. Both proxies exempt only a **top-level** navigation (`Sec-Fetch-Dest: document`): a navigation into an `<iframe>`, `<frame>`, `<embed>` or `<object>` is another site's doing, not a link the visitor followed.

**App-API responses can't run as the app.** Every proxied response now carries `X-Content-Type-Options: nosniff`, and one that is neither JSON nor a PDF carries `Content-Security-Policy: sandbox`, added to the upstream's own policy — so an HTML or SVG document from the API renders with an opaque origin and no script.

**The app-API proxy refuses double-encoded routes to lukk.** A path that one more round of percent-decoding turns into one of lukk's routes (`/api/x/%252e%252e/auth/login`, `/api/%2561uth/login`) is refused with `404`, so a decoding hop in front of the app cannot hand the browser lukk's token responses.

**Stripped request headers are removed, not sent empty.** The app-API proxy blanked the browser's `Origin`, `Cookie`, spoofable forwarding headers and those named in `Connection`, and they reached the upstream present but empty — an empty `Origin` is still one a CORS layer judges. They are now dropped.

**`/api/_lukk/refresh` accepts `POST` only**, answering anything else with `405` and `Allow: POST`.

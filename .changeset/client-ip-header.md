---
"lukk-nuxt": minor
---

Add `clientIpHeader`, an opt-in trusted-proxy setting that lets the upstream identify the real visitor.

Both proxies previously identified the caller by the **socket address** (`getRequestIP(event, { xForwardedFor: false })`). Behind any reverse proxy — nginx, Cloudflare, a load balancer — that address is the *proxy*, not the visitor, so an upstream keying on `$request->ip()` sees every visitor as one identity. Laravel's `throttle:5,1` on a public form then means **5 requests per minute globally**, not per client: one user can lock out everyone else. It's invisible until someone trips it, and no upstream configuration can fix it, because the information never reaches the request.

Blanking the spoofable headers is still right by default — otherwise any client could claim any IP and defeat upstream rate limiting or IP allowlists. What was missing was a way to say *"this hop is trusted"* when it genuinely is:

```ts
// nuxt.config
lukk: { clientIpHeader: 'cf-connecting-ip' } // or 'x-real-ip', …
```

Set it and every upstream call carries that address as `X-Forwarded-For`: the app-API proxy, the lukk auth proxy, **and the server-side token refresh**. The auth paths matter as much as the app API — lukk throttles `login`, `forgot-password` and `two-factor-challenge` on the caller's IP, and `/refresh` too (30/60s by default), which in BFF mode is the highest-volume auth call of all: every proxied 401 and every SSR hydration lands there. All of those were collapsing onto one bucket.

Security properties, unchanged by default:

- **Off unless set.** Every browser-settable forwarding header (`x-real-ip`, `cf-connecting-ip`, `true-client-ip`, `forwarded`, …) stays blanked, and the socket address is forwarded exactly as before. The auth proxy still sends no `X-Forwarded-For` at all rather than assert an address that identifies this server rather than the visitor.
- **A client cannot influence the value in either mode.** With the option unset the browser's own `x-forwarded-for` is never read; with it set, only the *named* header is, and the value replaces the client's chain rather than merging with it.
- **A list-valued trusted header is rejected outright.** A header the edge SETS carries exactly one address, but Node joins duplicates with `", "` and the **client's copy arrives first** — so on an edge that appends (or merely fails to strip the client's copy), trusting the leftmost entry would let a visitor forge `$request->ip()` upstream. Refusing turns that misconfiguration into a visible loss of function instead of a silent spoof.
- **The value must be an exact IP** (IPv4, or IPv6 via the WHATWG host parser — not `node:net`, which is absent from worker/edge presets). It can become an upstream rate-limit key or feed an IP allowlist, so anything else is discarded rather than forwarded.
- **The header must be one your edge SETS**, overwriting whatever the client sent (`cf-connecting-ip`, `x-real-ip`). One it merely appends to — the usual `x-forwarded-for` chain — leaves the leftmost entry client-controlled and is spoofable, so the module **warns at build** if you name one. Your upstream must also trust this hop (Laravel's `TrustProxies`) for `$request->ip()` to read it.
- **Your origin must not be reachable except through that edge.** There is no socket-peer check here (unlike `TrustProxies`), so a directly reachable origin — leaked origin IP, no firewall on the CDN ranges — lets a client set the header itself. Lock the origin down before enabling this. Enabling it also means your auth server sees and logs visitor IPs.
- **The auth paths assert the visitor or nothing.** Where the app-API proxy falls back to the socket address (it has always sent one), the lukk-facing calls send no `X-Forwarded-For` at all unless a visitor address was actually resolved — a wrong value there becomes a wrong rate-limit key.

Also **documents and pins the request-header pass-through**: request headers lukk doesn't explicitly strip or overwrite reach the upstream. Apps rely on this to carry per-visitor data across the proxy hop (e.g. geo-IP copied off `CF-*` onto a prefix Cloudflare won't re-stamp), and it was only ever an implicit consequence of h3's `proxyRequest`. There's now an end-to-end test pinning it, so an allowlist refactor can't silently regress it.

Two unrelated hardening fixes found while reviewing this:

- The app-API proxy now blanks the step-up **confirmation header** arriving from a client, symmetric with `authorization`. In BFF mode the browser never legitimately holds a step-up token, and the auth proxy was already immune (it builds its header set from scratch) — but the app-API proxy forwards unknown headers by default, so a client-set one could reach an app API gating routes on lukk's confirmation middleware.
- The module warns when `clientIpHeader` is set in `direct` mode, where it is dead config.

Also fixes a pre-existing cascade this change made far more likely: a **throttled refresh no longer destroys the session**. `refreshOnce` collapsed every failure into "no pair", and the auth proxy cleared the sealed session on that — so a `429` (or a 5xx, or an unusable `baseURL`) discarded a refresh token that was never consumed and still valid, turning a transient throttle into an unrecoverable logout. It now reports whether the failure was definitive, and only lukk actually rejecting the token (401/403) ends a session. That matters here because forwarding the real client IP makes `/refresh` the highest-volume throttled call.

---
"lukk-nuxt": patch
---

The BFF app-API proxy now transparently refreshes an expired session before forwarding.

Previously the app-API proxy (`api: { path, target }`) only injected whatever access token was sealed in the session — if it had lapsed since the last auth call, the request hit your Laravel API with a stale bearer and got a `401`, even though the session was still valid and refreshable.

Now the proxy decodes the injected access token and, if it has already expired **and** the session carries a refresh token, rotates it server-side *before* proxying. Key properties:

- **Shared single-flight.** The refresh reuses the same per-session single-flight as the `/api/_lukk/**` auth proxy, so a concurrent auth call and app-API call collapse to **one** `/refresh` — the rotating refresh token is never replayed (which reuse detection would punish with a full-family revoke).
- **Streaming preserved.** The body is still streamed (`streamRequest`), never buffered — uploads keep working. Refresh happens up-front on the token, not as a 401-retry that would require re-sending the body.
- **Revocation still surfaces.** A genuinely revoked session fails the refresh and Laravel returns its own `401` against the stale bearer — no false success.
- **Rotated cookie carried through.** The re-sealed session cookie survives the streamed proxy response; unauthenticated calls still never open (or set) a session cookie.

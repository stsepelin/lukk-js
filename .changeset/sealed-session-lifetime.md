---
"lukk-nuxt": minor
---

**Sealed BFF sessions now expire.** Every seal was written with no expiry, so a session cookie copied out of a browser could be unsealed indefinitely. Each seal is now written with a lifetime — new option `session.maxAge`, in seconds, default 30 days (lukk's default `refresh_ttl`) — which iron stamps into the seal and checks on every unseal; an expired seal reads as no session. Every refresh re-seals, so an active session is bounded by lukk's refresh family as before. Keep `maxAge` at least as long as lukk's `refresh_ttl`, or idle sessions end before their refresh token does. Seals written by earlier versions carry no expiry until they are next re-sealed.

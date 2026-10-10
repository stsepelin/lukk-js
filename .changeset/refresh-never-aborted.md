---
"lukk-nuxt": patch
---

**A server-side refresh is never cut short.** The 15-second upstream deadline also applied to the refresh, and aborting it after lukk had rotated the token lost the replacement: the session kept the consumed token, and its next refresh — past the grace window — was the replay reuse detection answers with a family revoke, a false logout. An abort cannot un-rotate a token, so the refresh now waits for lukk's answer, bounded only by the runtime's own transport timeouts; every request on a session shares that one call.

**The deadline covers the response body, not only its headers.** A lukk that sent headers and then stalled the body held the auth proxy's request until the socket timed out; it now fails at the deadline as a `502`. The background revocation of a dropped session is bounded by the same deadline.

---
"lukk-nuxt": patch
---

**A held rotation is kept only as long as it helps.** A rotation that landed after every caller gave up waits up to ten minutes for its first taker, then only 30 seconds more for requests already out with the old cookie. It is let go as soon as the session presents any other refresh token — so an old cookie surfacing later reaches lukk, whose reuse detection answers it — and when the session is logged out or replaced, so a logged-out session is never re-sealed. Its `expires_in` is what is left of the access token, not what it was when minted. A refresh in flight is joined only by a request presenting the token it is rotating.

**A refresh waiting out a `Retry-After` stands down for a logout** instead of renewing the session being ended and holding the logout behind the wait.

**The app-API proxy refuses a path in which decoding reveals a `.` or `..` segment**, so a chain of rewriting hops in front of the app cannot walk it onto lukk's routes.

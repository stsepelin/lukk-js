---
"lukk-nuxt": patch
---

**No rotation is lost to a caller that stopped waiting, or to a request still carrying the old cookie.** Every rotation the BFF makes is journalled per session, as a link from the refresh token it consumed to the pair it produced. A request still presenting a consumed token — from the auth proxy's `/refresh` or 401 retry, the app-API proxy, or SSR hydration — is handed the newest pair in that chain and seals it, instead of replaying a spent token that lukk's reuse detection would answer with a family revoke once its grace window had passed. While the newest pair's own token is being rotated, such a request waits for that rotation and is handed what it produced. Its `expires_in` is what is left of the access token.

Each link lives on its own: ten minutes for its first taker when no caller received the rotation, and 30 seconds from the moment one did — received when it landed, or taken since — for the requests already out with the old cookie. Taking one never extends another. The journal is dropped when the session presents a token outside it, when lukk refuses one of its tokens outright, and when the session is logged out or replaced; a throttle or an outage keeps it. A refresh in flight is joined only by a request presenting the token it is rotating. At most 16 links per session. The journal is per process: a multi-instance BFF without sticky sessions does not share it.

**A refresh waiting out a `Retry-After` stands down for a logout** instead of renewing the session being ended and holding the logout behind the wait.

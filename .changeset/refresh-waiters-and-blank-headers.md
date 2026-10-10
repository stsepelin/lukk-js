---
"lukk-nuxt": patch
---

**A slow refresh no longer holds the requests waiting on it, and its result is never lost.** The rotation itself is still never aborted, but each caller now waits at most 15 seconds: the auth proxy's `/refresh` answers `503` with `Retry-After: 5` (keeping the session), a proxied or app-API call goes ahead with the old access token, and an SSR render leaves the session to the client. What it produces is journalled for the session's next request still presenting the consumed token (see the rotation-journal entry). A refresh that never settles stops being shared after five minutes, so a hung connection cannot wedge a session on a runtime with no transport timeout of its own, and none of these timers keeps the process alive.

**The app-API proxy removes only the headers it blanked.** A header the browser itself sent with an empty value — `Accept` included, with `api.forceJson` off — is forwarded as sent, as RFC 9110 allows. **It refuses a route to lukk hidden behind a decoded `?` or `#`** (`/api/x%3F/%252e%252e/auth/login`). **A file name with a space in it is proxied again** — `/api/files/Annual%20Report.pdf` was refused as an encoded route to lukk, because the URL parser re-encodes a space and the double-decoding check never saw the path settle. Unread upstream bodies (a refused redirect, a refused refresh) are cancelled, releasing the connection.

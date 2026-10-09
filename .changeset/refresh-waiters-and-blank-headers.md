---
"lukk-nuxt": patch
---

**A slow refresh no longer holds the requests waiting on it.** The rotation itself is still never aborted, but each caller now waits at most 15 seconds: the auth proxy's `/refresh` then answers `503` with `Retry-After: 5`, keeping the session, and the retry joins the refresh still in flight instead of replaying the old token. A refresh that never settles stops being shared after five minutes, so a hung connection cannot wedge a session on a runtime with no transport timeout of its own.

**The app-API proxy removes only the headers it blanked.** A header the browser itself sent with an empty value is forwarded as sent, as RFC 9110 allows. **A file name with a space in it is proxied again** — `/api/files/Annual%20Report.pdf` was refused as an encoded route to lukk, because the URL parser re-encodes a space and the double-decoding check never saw the path settle. Unread upstream bodies (a refused redirect, a refused refresh) are cancelled, releasing the connection.

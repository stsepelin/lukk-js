---
"lukk-core": patch
"lukk-nuxt": patch
---

Three limits the 2026-11 audit wrote down and left, now fixed.

**lukk-nuxt**

- **A throttled refresh is told as a throttle, with lukk's own wait.** When lukk answered a refresh `429`, the BFF's `/refresh` answered a bare `503`: the app could say neither why nor for how long, where direct mode's refresh rejects with a `429` and `retryAfter`. It now answers `429` and passes on lukk's `Retry-After` (delay-seconds only). The session is kept, as before, and the client does not retry by itself — that is only for the BFF's own `503`, a refresh still out.
- **A page brought back from the back/forward cache re-checks who it is.** A frozen page is delivered no message from other tabs, so signing out and pressing Back showed the signed-in page again, and a sign-in in another tab meanwhile left the previous account on screen. On `pageshow` with `persisted`, the tab now asks (in direct mode, renewing from the cookie first). Nobody has said the session changed, so an answer that cannot be had changes nothing — Back while offline is not a logout — and a pending 2FA challenge or an earned step-up is dropped only when the answer names someone else, or no one.

**lukk-core**

- **`credentialToJSON` says which kind of authenticator answered, and writes extension buffers properly.** `authenticatorAttachment` is included where the browser reports one, and a buffer anywhere in the extension results is written as base64url — `JSON.stringify` wrote each as `{}`. Two members are left out on purpose: `prf.results` (key material derived for the page) and `largeBlob.blob`. They never reached the server before, by that same accident; lukk reads neither, and they do not belong in a request body. An app that wants either on its own server sends it itself.

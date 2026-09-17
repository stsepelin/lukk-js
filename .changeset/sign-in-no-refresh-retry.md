---
"lukk-core": minor
"lukk-nuxt": patch
---

**Sign-in calls no longer refresh and retry on a 401.** `login`, `register`, `twoFactorChallenge` and `loginWithPasskey` don't authenticate with the current session, so a 401 from one is the server's answer — lukk returns it for a passkey whose user no longer exists — not an expired access token. Refreshing on it rotated the refresh token of the session being replaced and then sent the credentials, or an already-spent passkey ceremony, a second time. They now reject with the 401 directly: in lukk-core's client, and in lukk-nuxt's BFF proxy for `/login`, `/register`, `/two-factor-challenge` and `/passkeys/login`.

`logout()` keeps its refresh-and-retry by default, and now accepts `{ retry: false }` for a binding that renews the token itself — lukk-nuxt does, so its refresh gate can't make a logout wait on its own renewal. It also sends an empty JSON body now (`Content-Type: application/json`) instead of none: lukk releases that end a session by its refresh cookie accept that only from a request a cross-site form couldn't have made, and the JSON body is that signal.

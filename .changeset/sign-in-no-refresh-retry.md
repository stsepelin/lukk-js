---
"lukk-core": patch
"lukk-nuxt": patch
---

**Sign-in calls no longer refresh and retry on a 401.** `login`, `register`, `twoFactorChallenge` and `loginWithPasskey` don't authenticate with the current session, so a 401 from one is the server's answer — lukk returns it for a passkey whose user no longer exists — not an expired access token. Refreshing on it rotated the refresh token of the session being replaced and then sent the credentials, or an already-spent passkey ceremony, a second time. They now reject with the 401 directly: in lukk-core's client, and in lukk-nuxt's BFF proxy for `/login`, `/register`, `/two-factor-challenge` and `/passkeys/login`.

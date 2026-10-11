---
"lukk-core": minor
"lukk-nuxt": minor
---

**A passkey sign-in can answer with a two-factor challenge.** lukk 0.7 answers a single-factor passkey assertion on an account with confirmed two-factor with `{ two_factor, challenge_token }` instead of a session. `loginWithPasskey()` is now typed `LoginResult`, and `useLukkPasskeys().login()` resolves to it: on a challenge it sets `pendingTwoFactor`, loads no user, and `useLukkAuth().verifyTwoFactor()` completes it, as after a password sign-in. Before, the challenge was dropped and the visitor was left on the sign-in page with nothing to type the code into. A challenge that arrives after the visitor logged out is discarded, and no second logout is sent, since no session was issued.

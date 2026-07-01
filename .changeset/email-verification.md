---
"lukk-core": minor
"lukk-nuxt": minor
---

Email verification client (pairs with lukk's opt-in `features.email_verification`). Adds `client.sendEmailVerification()` (lukk-core) and a `useLukkEmailVerification()` composable (lukk-nuxt) exposing `verified` (computed off the loaded user's `email_verified_at`), `sending`, `sendVerificationEmail()` (resend the link), and `syncAfterVerify()` (reload the user on your verify callback page). The verify link itself is a browser navigation from the email that redirects back to your SPA — the composable owns the resend + the post-redirect sync, not the verification click.

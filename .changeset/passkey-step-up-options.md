---
"lukk-core": minor
"lukk-nuxt": minor
---

**Passkey step-up asks lukk's own step-up options.** `useLukkPasskeys().confirm()` used the anonymous login options, which neither list the user's credentials nor ask for user verification. lukk 0.7 requires user verification at step-up whenever the account can reach AAL2 and refuses an assertion that lacks it, so a confirm made that way could never succeed. It now calls the new `passkeyConfirmationOptions()` (`POST /auth/confirm-passkey/options`) and falls back to the login options only on a 404 from an older lukk. A 403 from the options route abandons the pending confirmation, as a 403 from `confirm-passkey` already did.

**BREAKING (types): `Amr` holds the RFC 8176 registered values lukk 0.7 emits:** `'pwd' | 'otp' | 'pop' | 'user' | 'mfa'`. `'webauthn'` is gone; a passkey session is `pop` + `user`, and `mfa` marks a multi-factor one.

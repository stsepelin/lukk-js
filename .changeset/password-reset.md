---
"lukk-core": minor
"lukk-nuxt": minor
---

Add password reset (pairs with lukk's `features.password_reset`). `lukk-core` gains `forgotPassword(email)` and `resetPassword(input)` client methods plus a `ResetPasswordInput` type; `lukk-nuxt` gains the auto-imported `useLukkPasswordReset` composable (`sendResetLink`, `reset`, and `sending`/`resetting` flags). Both endpoints are public and route through the configured transport (BFF proxy or direct).

---
"lukk-core": minor
"lukk-nuxt": minor
---

Add registration (pairs with lukk's `features.registration`). `lukk-core` gains a `register(input)` client method plus `RegisterInput` / `RegisterResult` / `RegistrationPending` types and an `isRegistrationPending` guard. `lukk-nuxt`'s `useLukkAuth` gains `register()`, which mints a session exactly like `login()` — handling the same 2FA-challenge outcome and the verify-first (`block_unverified_login`) no-session response.

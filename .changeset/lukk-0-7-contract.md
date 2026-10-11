---
"lukk-core": minor
"lukk-nuxt": patch
---

**Aligned with lukk 0.7's contract.** `AccountExport.passkeys[]` gains `created_at`, `aaguid` and `transports` (optional — lukk 0.6.0 does not send them), and its `last_used_at` is now an ISO-8601 string rather than unix seconds, like every other time in the export: code that treated it as a number needs to parse it instead. `PasskeySummary` (`GET /auth/passkeys`) is unchanged. The two-factor and change-password composables document lukk 0.7's new refusals, and pass them through as plain `LukkError`s — no refresh, no retry, no sign-out: `confirm()` answers `409` on `code` when two-factor is already on, `regenerateRecoveryCodes()` `409` on `two_factor` without two-factor, and `confirmPassword()` (`422` on `password`) and `changePassword()` (`422` on `current_password`) from a session below the account's step-up level — an account with a second factor, signed in without it recently.

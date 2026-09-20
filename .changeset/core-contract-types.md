---
"lukk-core": patch
---

**Types matched to what lukk sends.** `PasskeySummary.last_used_at` (from `GET /auth/passkeys`) is a unix timestamp number, not a string — it always was at runtime, so code that treated it as a string was already wrong and now fails to typecheck. `AccountExport` gains an optional `lockouts` array (purpose, attempt count, timestamps) for lukk releases that include the account-lockout counters in the export.

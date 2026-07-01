---
"lukk-nuxt": minor
---

Support both step-up shapes — per-page and per-action — and complete the route-guard set.

- **Route guards:** add `lukk-verified` (send a logged-in user with an unverified email to `/verify-email`) and `lukk-confirmed` (send a logged-in user without a recent step-up confirmation to `/confirm-password`), matching `lukk-auth` / `lukk-guest`. Each acts only on an authenticated user (pair with `lukk-auth`); the server's `lukk.verified` (409) / `lukk.confirm` (423) remain the real enforcement. Use these to gate a **whole page/section**.
- **`useLukkConfirmation` modal flow:** add `withConfirmation(action)` for a **per-action** step-up — it runs the action and, on a `423`, drops any stale confirmation, flips the new reactive `required` (bind your modal to it), waits for a fresh confirm (password *or* passkey), and retries once. Plus `cancel()` to abort a pending prompt. This also fixes a stale-`confirmed` edge: a `423` now clears the client flag instead of leaving it optimistically true.

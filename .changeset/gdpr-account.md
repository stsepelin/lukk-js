---
"lukk-core": minor
"lukk-nuxt": minor
---

**Account erasure and export** — the client half of lukk 0.6's GDPR support.

```ts
const { deleteAccount, exportAccount, busy } = useLukkAccount()
```

Both endpoints need step-up **and** the `lukk.account.delete` ability, so a pinned machine token is
refused with a 403 unless it was minted carrying it. `lukk.account` does **not** satisfy it — use the
new `canDeleteAccount` from `useLukkAbilities()` to gate a "Delete my account" button, not
`canManageAccount`, which computes `true` for a token both routes refuse. `LUKK_ACCOUNT_DELETE` is
exported from `lukk-core`.

Both go through `withConfirmation`, so a missing or stale step-up surfaces your confirmation UI and
retries once — the same flow the two-factor and passkey management calls already use. `lukk-core`
gains `deleteAccount()` / `exportAccount()` and an `AccountExport` type.

`deleteAccount()` clears local auth state on success. The server has already revoked every token by
the time it resolves, so there is nothing to log out *of* — but `user` would otherwise sit there
describing an account that no longer exists, and route middleware would keep treating the visitor as
signed in until something else noticed. A **failed** erasure deliberately leaves that state alone:
the account still exists and the session is still valid.

The export is the **auth slice only** — sessions, passkeys, whether two-factor is on. lukk knows
nothing about your domain data, so presenting it alone as a subject-access response would
under-disclose. Credential material is deliberately absent: a TOTP secret, recovery codes and
refresh-token hashes are secrets whose only use is authenticating *as* the subject, not data they
benefit from receiving.

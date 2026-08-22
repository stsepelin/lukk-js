import type { AccountExport } from 'lukk-core'
import { ref, useNuxtApp } from '#imports'
import { useLukkAuth } from './useLukkAuth'
import { useLukkConfirmation } from './useLukkConfirmation'

/**
 * The signed-in user's own account: export it (GDPR Art. 15 / 20) or erase it (Art. 17).
 *
 * Both go through `withConfirmation`, so a missing or stale step-up surfaces your confirmation UI
 * and retries once — the same flow the two-factor and passkey management calls already use.
 */
export function useLukkAccount() {
  const { $lukk } = useNuxtApp()
  const { withConfirmation } = useLukkConfirmation()
  const { user, logout } = useLukkAuth()

  /** True while a call is in flight — bind a button's disabled state to it. */
  const busy = ref(false)

  /**
   * Erase the account. **Irreversible.**
   *
   * Clears local auth state on success. The server has already revoked every token by the time this
   * resolves, so there is nothing to log out OF — but `user` and the token state would otherwise sit
   * there describing an account that no longer exists, and route middleware would keep treating the
   * visitor as signed in until something else noticed.
   */
  async function deleteAccount(): Promise<void> {
    busy.value = true
    try {
      await withConfirmation(() => $lukk.deleteAccount())

      // `.catch()`, because `logout()` does NOT swallow — it is `try/finally`, which clears local
      // state and then RE-THROWS. And its call is guaranteed to fail here: the erasure already
      // denylisted this very token, so `POST /auth/logout` answers 401. Without this, every
      // successful, irreversible erasure rejected, and every consumer showed "erasure failed" for
      // an account that no longer exists.
      await logout().catch(() => {})
    }
    finally {
      busy.value = false
    }
  }

  /**
   * Download the personal data lukk holds.
   *
   * The **auth slice only** — sessions, passkeys, whether two-factor is on. lukk knows nothing about
   * your domain data, so presenting this alone as a subject-access response would under-disclose.
   */
  async function exportAccount(): Promise<AccountExport> {
    busy.value = true
    try {
      return await withConfirmation(() => $lukk.exportAccount())
    }
    finally {
      busy.value = false
    }
  }

  return { user, busy, deleteAccount, exportAccount }
}

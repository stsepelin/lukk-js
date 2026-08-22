import type { AccountExport } from 'lukk-core'
import { computed, ref, useNuxtApp } from '#imports'
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

  /**
   * True while ANY call is in flight — bind a button's disabled state to it.
   *
   * Counted, not a boolean. Two overlapping calls each cleared the same flag independently, so the
   * first to finish set it false while the second was still running and re-enabled the control
   * mid-flight. These calls are long-lived by construction: `withConfirmation` parks on a modal
   * waiting for the user, so overlap is the normal shape here rather than an edge case.
   */
  const inFlight = ref(0)
  const busy = computed(() => inFlight.value > 0)

  /** Run `fn` while holding the busy count, releasing it exactly once. */
  async function tracked<T>(fn: () => Promise<T>): Promise<T> {
    inFlight.value++
    try {
      return await fn()
    }
    finally {
      inFlight.value--
    }
  }

  /**
   * Erase the account. **Irreversible.**
   *
   * Clears local auth state on success. The server has already revoked every token by the time this
   * resolves, so there is nothing to log out OF — but `user` and the token state would otherwise sit
   * there describing an account that no longer exists, and route middleware would keep treating the
   * visitor as signed in until something else noticed.
   */
  async function deleteAccount(): Promise<void> {
    return tracked(async () => {
      await withConfirmation(() => $lukk.deleteAccount())

      // `.catch()`, because `logout()` does NOT swallow — it is `try/finally`, which clears local
      // state and then RE-THROWS. And its call is guaranteed to fail here: the erasure already
      // denylisted this very token, so `POST /auth/logout` answers 401. Without this, every
      // successful, irreversible erasure rejected, and every consumer showed "erasure failed" for
      // an account that no longer exists.
      await logout().catch(() => {})
    })
  }

  /**
   * Download the personal data lukk holds.
   *
   * The **auth slice only** — sessions, passkeys, whether two-factor is on. lukk knows nothing about
   * your domain data, so presenting this alone as a subject-access response would under-disclose.
   */
  async function exportAccount(): Promise<AccountExport> {
    return tracked(() => withConfirmation(() => $lukk.exportAccount()))
  }

  return { user, busy, deleteAccount, exportAccount }
}

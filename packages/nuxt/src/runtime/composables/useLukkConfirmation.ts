import { computed, useNuxtApp, useState } from '#imports'
import { CONFIRMATION_KEY, CONFIRMED_KEY } from '../keys'

/**
 * Step-up ("sudo") confirmation. Re-confirm identity to unlock sensitive,
 * `lukk.confirm`-gated actions (2FA + passkey management) for a short window.
 *
 * In **direct** mode the token is stored in `lukk:confirmation` and the client
 * attaches it as `X-Lukk-Confirmation` automatically. In **bff** mode the proxy
 * strips and holds the token server-side (the browser never sees it) and injects
 * the header itself — so here only the `confirmed` flag is set. Either way,
 * `confirmed` going true unlocks the gated actions until the window expires.
 */
export function useLukkConfirmation() {
  const { $lukk } = useNuxtApp()
  const token = useState<string | null>(CONFIRMATION_KEY, () => null)
  const confirmedFlag = useState<boolean>(CONFIRMED_KEY, () => false)
  const confirmed = computed(() => confirmedFlag.value)

  /** Re-confirm with the account password. */
  async function confirmPassword(password: string): Promise<void> {
    record(await $lukk.confirmPassword(password))
  }

  /**
   * Record a confirmation result: store the token when present (direct mode) and
   * flip `confirmed`. Shared with the passkey step-up path.
   */
  function record(result: { confirmation_token?: string }): void {
    if (result.confirmation_token) token.value = result.confirmation_token
    confirmedFlag.value = true
  }

  /** Drop the confirmation (e.g. after the sensitive action completes). */
  function clear(): void {
    token.value = null
    confirmedFlag.value = false
  }

  return { confirmed, token, confirmPassword, record, clear }
}

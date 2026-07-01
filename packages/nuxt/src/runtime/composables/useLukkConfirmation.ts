import { computed, useNuxtApp, useState, watch } from '#imports'
import { CONFIRM_REQUIRED_KEY, CONFIRMATION_KEY, CONFIRMED_KEY } from '../keys'

/**
 * Step-up ("sudo") confirmation. Re-confirm identity to unlock sensitive,
 * `lukk.confirm`-gated actions (2FA + passkey management) for a short window.
 *
 * In **direct** mode the token is stored in `lukk:confirmation` and the client
 * attaches it as `X-Lukk-Confirmation` automatically. In **bff** mode the proxy
 * strips and holds the token server-side (the browser never sees it) and injects
 * the header itself — so here only the `confirmed` flag is set. Either way,
 * `confirmed` going true unlocks the gated actions until the window expires.
 *
 * Two usage shapes, both supported:
 *  - **Per-action (modal):** wrap the call in `withConfirmation()` — on a `423` it
 *    opens your modal (`required`), waits for a fresh confirm, and retries once.
 *  - **Per-page (section):** gate the route with the `lukk-confirmed` middleware.
 */
export function useLukkConfirmation() {
  const { $lukk } = useNuxtApp()
  const token = useState<string | null>(CONFIRMATION_KEY, () => null)
  const confirmedFlag = useState<boolean>(CONFIRMED_KEY, () => false)
  const confirmed = computed(() => confirmedFlag.value)
  // True while a `withConfirmation` action is waiting on a fresh step-up — bind your modal to it.
  const required = useState<boolean>(CONFIRM_REQUIRED_KEY, () => false)

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

  /**
   * Run a `lukk.confirm`-gated action with the modal step-up flow: attempt it, and if
   * the server demands confirmation (`423`), drop any stale confirmation, flip `required`
   * so your modal opens, wait for a fresh confirm (via `confirmPassword` or
   * `useLukkPasskeys().confirm()` — both flip `confirmed`), then retry once. Rejects if the
   * modal is cancelled (`cancel()`). For a whole page/section, use the `lukk-confirmed`
   * middleware instead.
   */
  async function withConfirmation<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action()
    }
    catch (error) {
      if ((error as { status?: number }).status !== 423) throw error
      // The server rejected our confirmation → it's missing or stale; earn a fresh one.
      clear()
      required.value = true
      try {
        await confirmedOrCancelled()
      }
      finally {
        required.value = false
      }
      return action() // retry once, now confirmed
    }
  }

  /** Resolve when a fresh confirmation lands (`confirmed` → true); reject if cancelled. */
  function confirmedOrCancelled(): Promise<void> {
    return new Promise((resolve, reject) => {
      const stop = watch([confirmedFlag, required], ([ok, req]) => {
        // `confirmed` wins over `required` going false, so a concurrent retry can't cancel this one.
        if (ok) { stop(); resolve() }
        else if (!req) { stop(); reject(new Error('lukk: confirmation cancelled')) }
      })
    })
  }

  /** Cancel a pending `withConfirmation` (call from your modal's close/cancel button). */
  function cancel(): void {
    required.value = false
  }

  return { confirmed, required, token, confirmPassword, record, clear, withConfirmation, cancel }
}

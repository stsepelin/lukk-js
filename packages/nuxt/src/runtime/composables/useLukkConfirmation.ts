import type { ComputedRef, Ref } from 'vue'
import { computed, useNuxtApp, useState, watch } from '#imports'
import { CONFIRM_REQUIRED_KEY, CONFIRMED_KEY } from '../keys'
import { useLukkSecret } from '../utils/secrets'

/**
 * Declared rather than inferred: the module build cannot resolve `#imports`, so an inferred return type
 * shipped as `any` in the published declarations — and `confirmed.value = true` type-checked in a
 * consumer app. `required` and `token` are read-only too: flip them with `cancel()`/`record()`/`clear()`.
 */
export interface LukkConfirmation {
  abandonIfUnearnable: (error: unknown) => void
  confirmed: ComputedRef<boolean>
  required: Readonly<Ref<boolean>>
  token: Readonly<Ref<string | null>>
  /**
   * Re-confirm with the account password. Rejects with a `422` on `password` for a wrong password — and
   * (lukk 0.7) for an account with a second factor when this session is not a recent multi-factor one:
   * confirm with a user-verifying passkey there, or sign in again with the second factor.
   */
  confirmPassword: (password: string) => Promise<void>
  record: (result: { confirmation_token?: string }) => void
  clear: () => void
  withConfirmation: <T>(action: () => Promise<T>) => Promise<T>
  cancel: () => void
}

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
export function useLukkConfirmation(): LukkConfirmation {
  const nuxtApp = useNuxtApp()
  const { $lukk } = nuxtApp
  const token = useLukkSecret('confirmation')
  const confirmedFlag = useState<boolean>(CONFIRMED_KEY, () => false)
  const confirmed = computed(() => confirmedFlag.value)
  // True while a `withConfirmation` action is waiting on a fresh step-up — bind your modal to it.
  const required = useState<boolean>(CONFIRM_REQUIRED_KEY, () => false)

  // The error that made a step-up unearnable, so the caller sees it instead of "cancelled". Shared by every
  // instance of this composable in the app: the action waiting is usually a PAGE's `withConfirmation()`,
  // and the 403 arrives through the MODAL's own `confirmPassword()` — held per instance, it never reached
  // the waiter. On the app rather than in `useState`: the app is per request on the server, so nothing
  // leaks between visitors, and unlike `useState` it is never serialised into the payload nor wrapped in a
  // reactive proxy — the caller gets the very error lukk answered with.
  // `earned` is replaced by a fresh object on every confirmation recorded in this app, so a 423 can tell
  // whether one landed after the request it answers was sent.
  const stepUp = ((nuxtApp as { _lukkStepUp?: { unearnable?: unknown, earned?: object } })._lukkStepUp ??= {})

  /**
   * Re-confirm with the account password. A `422` on `password` is a wrong password, or (lukk 0.7) an
   * account whose second factor this session does not meet — the password cannot raise it; a user-verifying
   * passkey (`useLukkPasskeys().confirm()`) or a fresh multi-factor sign-in can.
   */
  async function confirmPassword(password: string): Promise<void> {
    try {
      record(await $lukk.confirmPassword(password))
    }
    catch (error) {
      abandonIfUnearnable(error)
      throw error
    }
  }

  /**
   * A 403 from a step-up route means this TOKEN may never earn a confirmation — it is a pinned
   * machine token without `lukk.account`, not a wrong password.
   *
   * Without this the modal deadlocks: `withConfirmation` sets `required` and waits for `confirmed`,
   * which can never flip, so the promise never settles, the dialog stays open, and every retry burns
   * the shared step-up throttle. Dropping `required` lets `confirmedOrCancelled` reject so the
   * original call fails with a real error instead of hanging.
   */
  function abandonIfUnearnable(error: unknown): void {
    if ((error as { status?: number }).status !== 403) return

    // Stashed so `confirmedOrCancelled` can reject with the REAL error. Rejecting with a synthetic
    // "confirmation cancelled" told the caller the user dismissed a modal they never saw, and threw
    // away the 403 that actually explains it — now the expected outcome for any machine token
    // holding `lukk.account` but not `lukk.account.delete`.
    stepUp.unearnable = error
    required.value = false
  }

  /**
   * Record a confirmation result: store the token when present (direct mode) and
   * flip `confirmed`. Shared with the passkey step-up path.
   */
  function record(result: { confirmation_token?: string }): void {
    // Client-only, both halves: a step-up is earned by a request the browser made, and a `true` serialised
    // into `__NUXT_DATA__` would claim one for whoever the render is later handed to.
    // Stryker disable next-line ConditionalExpression: the mutation run compiles the client, where this is `true` already; the server half is pinned in test/server-env/confirmation.test.ts.
    if (import.meta.client) {
      if (result.confirmation_token) token.value = result.confirmation_token
      confirmedFlag.value = true
      stepUp.earned = {}
    }
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
    const earnedBefore = stepUp.earned
    try {
      return await action()
    }
    catch (error) {
      if ((error as { status?: number }).status !== 423) throw error
      // A confirmation landed while this request was out — the 423 answers the request, not that
      // confirmation. Clearing it wiped the step-up just earned (another action's modal) and asked again:
      // retry once with it instead.
      if (stepUp.earned !== earnedBefore) return action()
      // The server rejected our confirmation → it's missing or stale; earn a fresh one.
      clear()
      // Reset per CYCLE. `unearnable` is otherwise only ever set, so once one action hit
      // a 403 every later cancellation rejected with that stale 403 —
      // reporting "this token can never earn a step-up" for an operation the user simply dismissed.
      stepUp.unearnable = null
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
        if (ok) {
          stop()
          resolve()
          return
        }
        // Stryker disable next-line ConditionalExpression: equivalent — `confirmed` is cleared before this watcher starts and it stops the moment `confirmed` turns true, so while it is alive the only change it can see with `ok` false is `required` going false.
        if (!req) { stop(); reject(stepUp.unearnable ?? new Error('lukk: confirmation cancelled')) }
      })
    })
  }

  /** Cancel a pending `withConfirmation` (call from your modal's close/cancel button). */
  function cancel(): void {
    required.value = false
  }

  return { abandonIfUnearnable, confirmed, required, token, confirmPassword, record, clear, withConfirmation, cancel }
}

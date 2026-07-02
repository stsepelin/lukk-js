import type { ResetPasswordInput } from 'lukk-core'
import { ref, useNuxtApp } from '#imports'

/**
 * Password reset (pairs with lukk's `features.password_reset`).
 *
 * Both endpoints are public — the user is logged out. `sendResetLink(email)` asks lukk to
 * email a reset link (it always resolves, even for an unknown address — no user enumeration);
 * the link lands on your SPA reset page carrying `?token=…&email=…`, which you hand to
 * `reset()` along with the new password. On success the user can log in with the new password
 * (lukk revokes any pre-existing sessions by default), so route them to your login page.
 */
export function useLukkPasswordReset() {
  const { $lukk } = useNuxtApp()

  /** True while the reset-link request is in flight — bind a button's disabled state to it. */
  const sending = ref(false)

  /** True while the reset submission is in flight. */
  const resetting = ref(false)

  /** Request a password-reset link be emailed to `email`. */
  async function sendResetLink(email: string): Promise<void> {
    sending.value = true
    try {
      await $lukk.forgotPassword(email)
    }
    finally {
      sending.value = false
    }
  }

  /** Complete the reset with the token + email from the link and the new password. */
  async function reset(input: ResetPasswordInput): Promise<void> {
    resetting.value = true
    try {
      await $lukk.resetPassword(input)
    }
    finally {
      resetting.value = false
    }
  }

  return { sending, resetting, sendResetLink, reset }
}

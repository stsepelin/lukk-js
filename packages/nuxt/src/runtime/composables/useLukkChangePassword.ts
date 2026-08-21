import type { ChangePasswordInput } from 'lukk-core'
import { ref, useNuxtApp } from '#imports'

/**
 * Change the signed-in user's password (pairs with lukk's `features.change_password`).
 *
 * Named for the one operation it performs, not for the noun: `useLukkPassword` would read as an
 * umbrella that also covers the reset flow, and it doesn't.
 *
 * The counterpart to {@link useLukkPasswordReset}, which is for a user who *can't* sign in. Here
 * the current password is the proof — there's no emailed token — which is what stops a stolen
 * access token from being enough to take the account over permanently.
 *
 * lukk revokes every OTHER session on success and keeps this one, so there is nothing to re-login
 * and no token to swap: the composables' state is already correct afterwards. A wrong current
 * password is a `422` on `current_password`; the endpoint shares the step-up throttle, so a burst
 * of wrong guesses is a `429` and, where the account lockout is on, eventually a `423`.
 */
export function useLukkChangePassword() {
  const { $lukk } = useNuxtApp()

  /** True while the change is in flight — bind a submit button's disabled state to it. */
  const changing = ref(false)

  /**
   * Change the password. Rejects with a `LukkError` on failure — `422` carries Laravel's validation
   * bag, so {@link useLukkForm} maps it onto your fields.
   */
  async function changePassword(input: ChangePasswordInput): Promise<void> {
    changing.value = true
    try {
      await $lukk.changePassword(input)
    }
    finally {
      changing.value = false
    }
  }

  return { changing, changePassword }
}

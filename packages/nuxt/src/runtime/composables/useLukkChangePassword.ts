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
   *
   * A call made while one is already in flight is refused **without a request**. That is not
   * bookkeeping for the flag above: the second request would carry a `current_password` the first
   * has already replaced, so lukk reads it as a wrong password and spends one of the account's
   * consecutive-failure attempts. A double-submit would quietly eat the user's lockout budget and
   * report a `422` for a change that had in fact just succeeded.
   *
   * Refusing also makes `changing` correct by construction — there is never more than one in
   * flight, so a single boolean cannot go stale. (The sibling composables need no equivalent: a
   * reset link or a verification resend is idempotent and verifies no secret, so a duplicate there
   * costs nothing.)
   */
  async function changePassword(input: ChangePasswordInput): Promise<void> {
    if (changing.value) {
      throw Object.assign(new Error('A password change is already in progress.'), { status: 409 })
    }

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

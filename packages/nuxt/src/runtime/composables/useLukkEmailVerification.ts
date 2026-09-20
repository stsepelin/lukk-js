import { isEmailVerified } from 'lukk-core'
import type { ComputedRef, Ref } from 'vue'
import { computed, ref, useNuxtApp } from '#imports'
import { useLukkAuth } from './useLukkAuth'

/**
 * Declared rather than inferred: the module build cannot resolve `#imports`, so an inferred return type
 * shipped as `any` in the published declarations — and `verified.value = true` type-checked in a consumer app.
 */
export interface LukkEmailVerification {
  verified: ComputedRef<boolean>
  sending: Readonly<Ref<boolean>>
  sendVerificationEmail: () => Promise<void>
  syncAfterVerify: () => Promise<void>
}

/**
 * Email verification (pairs with lukk's `features.email_verification`).
 *
 * The verify link is clicked straight from an email — a browser navigation, not an
 * XHR — so this composable doesn't perform the verification itself. It owns the two
 * things the client does: (re)sending the link, and reflecting the loaded user's
 * verified state. After the link bounces the user back to your verify page, call
 * `syncAfterVerify()` there to reload the user so `verified` (and any "verify your
 * email" banner) updates.
 */
export function useLukkEmailVerification(): LukkEmailVerification {
  const { $lukk } = useNuxtApp()
  const { user, fetchUser } = useLukkAuth()

  /** Whether the loaded user's email is verified (`email_verified_at` or the `email_verified` boolean). */
  const verified = computed(() => isEmailVerified(user.value))

  /** True while a resend request is in flight — bind a button's disabled state to it. */
  const sending = ref(false)

  /** Resend the verification link to the current user (a no-op server-side if already verified). */
  async function sendVerificationEmail(): Promise<void> {
    sending.value = true
    try {
      await $lukk.sendEmailVerification()
    }
    finally {
      sending.value = false
    }
  }

  /** Reload the user after returning from the verification link, so `verified` flips. */
  function syncAfterVerify(): Promise<void> {
    return fetchUser()
  }

  return { verified, sending, sendVerificationEmail, syncAfterVerify }
}

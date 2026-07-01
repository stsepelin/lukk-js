import { useLukkAuth } from '../composables/useLukkAuth'
import { useLukkEmailVerification } from '../composables/useLukkEmailVerification'
import { defineNuxtRouteMiddleware, navigateTo } from '#imports'

/**
 * Route guard: send a logged-in user whose email isn't verified to /verify-email.
 * Only acts on an authenticated user (pair with `lukk-auth` for pages that also
 * require login); the server's `lukk.verified` 409 is the real enforcement.
 * Usage: `definePageMeta({ middleware: ['lukk-auth', 'lukk-verified'] })`.
 */
export default defineNuxtRouteMiddleware((to) => {
  const { loggedIn } = useLukkAuth()
  const { verified } = useLukkEmailVerification()
  if (loggedIn.value && !verified.value && to.path !== '/verify-email') {
    return navigateTo('/verify-email')
  }
})

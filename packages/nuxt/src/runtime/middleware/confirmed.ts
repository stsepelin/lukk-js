import { useLukkAuth } from '../composables/useLukkAuth'
import { useLukkConfirmation } from '../composables/useLukkConfirmation'
import { defineNuxtRouteMiddleware, navigateTo } from '#imports'

/**
 * Route guard: send a logged-in user who hasn't done a recent step-up confirmation
 * to /confirm-password. Only acts on an authenticated user (pair with `lukk-auth`);
 * the server's `lukk.confirm` 423 is the real enforcement. Confirmation is client-
 * session state, so a hard reload re-confirms.
 * Usage: `definePageMeta({ middleware: ['lukk-auth', 'lukk-confirmed'] })`.
 */
export default defineNuxtRouteMiddleware((to) => {
  const { loggedIn } = useLukkAuth()
  const { confirmed } = useLukkConfirmation()
  if (loggedIn.value && !confirmed.value && to.path !== '/confirm-password') {
    return navigateTo('/confirm-password')
  }
})

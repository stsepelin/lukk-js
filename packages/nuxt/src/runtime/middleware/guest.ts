import { useLukkAuth } from '../composables/useLukkAuth'
import { defineNuxtRouteMiddleware, navigateTo } from '#imports'

/**
 * Route guard: bounce already-authenticated users away (e.g. off /login).
 * Usage: `definePageMeta({ middleware: 'lukk-guest' })`.
 */
export default defineNuxtRouteMiddleware((to) => {
  const { loggedIn } = useLukkAuth()
  if (loggedIn.value && to.path !== '/') {
    return navigateTo('/')
  }
})

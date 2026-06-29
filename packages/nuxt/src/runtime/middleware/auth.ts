import { useLukkAuth } from '../composables/useLukkAuth'
import { defineNuxtRouteMiddleware, navigateTo } from '#imports'

/**
 * Route guard: redirect to /login when not authenticated.
 * Usage: `definePageMeta({ middleware: 'lukk-auth' })`.
 */
export default defineNuxtRouteMiddleware((to) => {
  const { loggedIn } = useLukkAuth()
  if (!loggedIn.value && to.path !== '/login') {
    return navigateTo('/login')
  }
})

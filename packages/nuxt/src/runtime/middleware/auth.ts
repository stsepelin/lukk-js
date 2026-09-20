import { useLukkAuth } from '../composables/useLukkAuth'
import { defineNuxtRouteMiddleware, navigateTo } from '#imports'

/**
 * Route guard: redirect to /login when not authenticated.
 * Usage: `definePageMeta({ middleware: 'lukk-auth' })`.
 *
 * Only once the session is RESOLVED. `loggedIn: false` also means "not known yet" — on a server render
 * that could not resolve the session (direct mode, an anonymous-looking BFF render, `ssrHydrate: false`,
 * a prerendered route) — and redirecting there sent a signed-in visitor to /login before their client
 * had restored them. It defers instead: the same middleware runs again on the client, after the restore.
 *
 * Nor when the restore could not reach an answer (`restoreFailed`): the visitor may well be signed in,
 * so the page stays and can offer a retry. Route middleware is not access control — the API is.
 */
export default defineNuxtRouteMiddleware((to) => {
  if (to.path === '/login') return

  const { loggedIn, ready, restoreFailed } = useLukkAuth()
  if (!ready.value || restoreFailed.value) return
  if (!loggedIn.value) return navigateTo('/login')
})

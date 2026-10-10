import { resolveHydrationAccess, withholdIfReplaced } from '../server/hydrate'
import { defineNuxtPlugin } from '#imports'

/**
 * BFF with `ssrHydrate: false`: renew an aged-out session before the render — and nothing else.
 *
 * A render's own app-API requests never renew the session (see `render-marker.server.ts`): their cookie
 * would go back to the render, never to the page. With hydration on, `session.server` renews it first;
 * with it off, nothing did, and every page rendered after the access token aged out answered its SSR
 * `useFetch` calls 401 — which Nuxt does not re-fetch on hydration, so the page showed the error.
 *
 * The same step hydration takes, without loading the user: `resolveHydrationAccess` rotates once,
 * re-seals onto the page response and mirrors the seal into the in-process request, so every in-render
 * request carries the fresh token. The cookie leaves with the page, and gets the same last check there —
 * withheld should a sign-in or logout end the session meanwhile, re-sealed with the newest pair should it
 * have rotated since.
 */
export default defineNuxtPlugin({
  name: 'lukk:session-renew',
  async setup(nuxtApp) {
    if (!nuxtApp.payload.serverRendered || nuxtApp.payload.prerenderedAt) return
    const event = nuxtApp.ssrContext?.event
    if (!event) return

    if (!(await resolveHydrationAccess(event))) return
    // A render that throws skips `app:rendered`, and the error page still carries the queued cookie.
    nuxtApp.hooks.hook('app:rendered', () => withholdIfReplaced(event))
    nuxtApp.hooks.hook('app:error', () => withholdIfReplaced(event))
  },
})

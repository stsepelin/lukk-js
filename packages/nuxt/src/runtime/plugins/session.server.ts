import { setResponseHeader } from 'h3'
import { useLukkAuth } from '../composables/useLukkAuth'
import { resolveHydrationAccess } from '../server/hydrate'
import { defineNuxtPlugin } from '#imports'

/**
 * BFF SSR auth hydration. Per request, on the server, seed `useLukkAuth().user` from
 * the sealed session so an authenticated page renders logged-in on the first paint —
 * no logged-out→logged-in flash, no consumer `<ClientOnly>`. Registered only in BFF
 * mode with `ssrHydrate` on (the default).
 *
 * Security (see docs/transport-modes.md):
 *  - Seeds ONLY the app `user` resource into the payload; the access/refresh token
 *    never leaves the server (`fetchUser` writes `user`, never the token state).
 *  - Marks the response `Cache-Control: no-store` whenever a usable session is resolved —
 *    NOT gated on the user seeding successfully — so a shared cache/CDN can never store
 *    either a per-user render OR the rotated session `Set-Cookie` that `resolveHydrationAccess`
 *    may have queued (which a `fetchUser` failure would otherwise leave cacheable). This
 *    matches the unconditional `no-store` the BFF/app-API proxies emit.
 *  - Skips prerendered / statically-cached pages (they'd bake one user into a shared
 *    payload) — those restore on the client instead.
 *  - When the access token has aged out but the session is still refreshable,
 *    `resolveHydrationAccess` rotates + re-seals in place (onto both the page response and
 *    the in-process request), so a full page load stays logged-in instead of flashing
 *    /login. An anonymous or unrefreshable session yields null and defers to the client.
 */
export default defineNuxtPlugin({
  name: 'lukk:session-hydrate',
  dependsOn: ['lukk:client'],
  async setup(nuxtApp) {
    if (!nuxtApp.payload.serverRendered || nuxtApp.payload.prerenderedAt) return
    const event = nuxtApp.ssrContext?.event
    if (!event) return

    const access = await resolveHydrationAccess(event)
    if (!access) return

    // The rotate path may have queued a fresh session Set-Cookie here, so suppress shared caching
    // now — before fetchUser can fail and leave a rotated cookie or per-user render cacheable.
    setResponseHeader(event, 'cache-control', 'no-store')

    await useLukkAuth().fetchUser()
  },
})

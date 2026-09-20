import { setResponseHeader } from 'h3'
import { useLukkAuth } from '../composables/useLukkAuth'
import { READY_KEY, USER_KEY } from '../keys'
import { hydratedSessionEnded, resolveHydrationAccess, withholdIfReplaced } from '../server/hydrate'
import { defineNuxtPlugin, useState } from '#imports'

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
 *  - Marks `ready` ONLY when a user was actually hydrated — never for an anonymous render. That
 *    render carries no `no-store`, so a shared cache or CDN may serve it to anyone, including a
 *    signed-in visitor whose cookie the edge ignored. A baked-in `ready: true` would tell that
 *    visitor's client the session was already resolved, and they would stay signed out. The
 *    hydrated render is per-user and `no-store` (above), so the flag only ever reaches its owner.
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

    // A re-sealed cookie leaves with the page, after the whole render: check its session once more then.
    // On `app:error` too — a render that throws skips `app:rendered`, and the error page still carries
    // every cookie queued so far.
    nuxtApp.hooks.hook('app:rendered', () => withholdIfReplaced(event))
    nuxtApp.hooks.hook('app:error', () => withholdIfReplaced(event))

    // The rotate path may have queued a fresh session Set-Cookie here, so suppress shared caching
    // now — before fetchUser can fail and leave a rotated cookie or per-user render cacheable.
    setResponseHeader(event, 'cache-control', 'no-store')

    const auth = useLukkAuth()
    await auth.fetchUser()

    // Ended by a sign-in or logout while the user loaded: render signed out and unresolved, so the client
    // restores with the cookie the browser now holds instead of showing the account that just left.
    if (await hydratedSessionEnded(event)) {
      // Stryker disable next-line ArrowFunction: equivalent — the initial value is overwritten on the next line.
      const user = useState(USER_KEY, () => null)
      user.value = null
      // Now, not only in the render hooks: with streaming the headers are already out by then.
      await withholdIfReplaced(event)
      return
    }

    // A transient user-endpoint failure leaves `user` null — not resolved, so the client restores.
    if (auth.loggedIn.value) {
      // Stryker disable next-line ArrowFunction,BooleanLiteral: equivalent — the initial value is overwritten on the next line.
      const ready = useState<boolean>(READY_KEY, () => false)
      ready.value = true
    }
  },
})

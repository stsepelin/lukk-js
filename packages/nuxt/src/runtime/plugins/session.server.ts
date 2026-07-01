import { setResponseHeader } from 'h3'
import { useLukkAuth } from '../composables/useLukkAuth'
import { accessExpired } from '../server/access-token'
import { getLukkAccessToken } from '../server/utils/session'
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
 *  - Marks the response `Cache-Control: no-store` once a user is seeded, so a shared
 *    cache/CDN can't serve one user's per-user render to another (the sealed cookie
 *    header alone does not prevent caching).
 *  - Skips prerendered / statically-cached pages (they'd bake one user into a shared
 *    payload) — those restore on the client instead.
 *  - Hydrates only with a still-valid access token; an expired one would make the
 *    app-API proxy rotate + re-seal the session mid-render (a Set-Cookie hazard), so
 *    that case defers to the client restore.
 */
export default defineNuxtPlugin({
  name: 'lukk:session-hydrate',
  dependsOn: ['lukk:client'],
  async setup(nuxtApp) {
    if (!nuxtApp.payload.serverRendered || nuxtApp.payload.prerenderedAt) return
    const event = nuxtApp.ssrContext?.event
    if (!event) return

    const access = await getLukkAccessToken(event)
    if (!access || accessExpired(access)) return

    const auth = useLukkAuth()
    await auth.fetchUser()

    if (auth.loggedIn.value) setResponseHeader(event, 'cache-control', 'no-store')
  },
})

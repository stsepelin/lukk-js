import { LUKK_SSR_HEADER } from '../shared'
import { defineNuxtPlugin } from '#imports'

/**
 * BFF: mark the page request itself as a render (`LUKK_SSR_HEADER`), first thing.
 *
 * Every in-render fetch Nuxt makes — `useFetch('/api/…')`, `useRequestFetch()`, `event.$fetch` — copies
 * this request's headers, the session cookie included, into its in-process request. Without the marker the
 * app-API proxy took such a request for the browser's own and renewed the session for it: the rotated
 * cookie went back to the render, never to the page, and the browser replayed the consumed token into a
 * revoke. Marked, the proxy passes the token on as it is; SSR hydration is the one place a render renews.
 *
 * Registered in BFF mode whatever `ssrHydrate` says: with hydration off, `session-renew.server` renews an
 * aged-out session before the render instead. A server ROUTE's `event.$fetch('/api/…')` is not a render and
 * is not marked; one that needs the session reads it with `getLukkAccessToken`.
 */
export default defineNuxtPlugin({
  name: 'lukk:render-marker',
  enforce: 'pre',
  setup(nuxtApp) {
    const event = nuxtApp.ssrContext?.event
    if (event) event.node.req.headers[LUKK_SSR_HEADER] = '1'
  },
})

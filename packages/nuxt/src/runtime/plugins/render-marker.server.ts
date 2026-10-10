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
 * Registered in BFF mode whatever `ssrHydrate` says: with hydration off, a render's app-API call on an
 * expired token now answers 401 rather than renewing, and the client renews after hydration.
 */
export default defineNuxtPlugin({
  name: 'lukk:render-marker',
  enforce: 'pre',
  setup(nuxtApp) {
    const event = nuxtApp.ssrContext?.event
    if (event) event.node.req.headers[LUKK_SSR_HEADER] = '1'
  },
})

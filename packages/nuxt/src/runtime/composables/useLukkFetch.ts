import { ofetch } from 'ofetch'
import { navigateTo, useNuxtApp, useRequestHeaders, useRuntimeConfig, useState } from '#imports'
import { ACCESS_KEY } from '../keys'
import { createLukkFetch } from '../utils/create-lukk-fetch'

interface PublicLukk {
  mode: 'bff' | 'direct'
  apiBaseURL: string
}

/**
 * An auth-aware fetch for your OWN app API — the piece a plain `$fetch` gets wrong
 * (it forwards no cookie in SSR → a silent 401). Transport-aware:
 *
 *  - **BFF**: same-origin to the proxy mount; on SSR it forwards the sealed session
 *    cookie (only `cookie`), and the proxy injects the bearer + refreshes server-side.
 *  - **direct**: attaches the in-memory bearer and single-flights a 401 refresh+retry
 *    (sharing `$lukk`'s refresh, so the rotating token is never replayed).
 *
 * Always JSON, `redirect: 'manual'`, and rejects with a typed `LukkError`.
 * In a server route, pair with `getLukkAccessToken(event)` instead.
 */
export function useLukkFetch() {
  const cfg = useRuntimeConfig().public.lukk as PublicLukk
  const access = useState<string | null>(ACCESS_KEY, () => null)
  const nuxtApp = useNuxtApp() as { $lukkRefresh?: () => Promise<unknown> }
  const isDirect = cfg.mode === 'direct'
  // Capture the request cookie eagerly, in valid Nuxt context — reading it lazily inside
  // ofetch's interceptor can lose the SSR async context (empty on the client).
  const cookie = useRequestHeaders(['cookie']).cookie

  return createLukkFetch({
    baseURL: cfg.apiBaseURL,
    isServer: import.meta.server === true,
    // Direct mode holds the token in client memory; SSR has none, so nothing to refresh.
    canRefresh: isDirect && import.meta.client === true,
    getCookieHeader: () => cookie,
    getBearer: () => (isDirect ? access.value : null),
    refresh: () => nuxtApp.$lukkRefresh?.() ?? Promise.resolve(null),
    onRedirect: location => navigateTo(location, { external: true }),
    fetchImpl: ofetch,
  })
}

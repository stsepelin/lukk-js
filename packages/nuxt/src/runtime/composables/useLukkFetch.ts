import { isSameOrigin } from 'lukk-core'
import { ofetch } from 'ofetch'
import { navigateTo, useNuxtApp, useRequestFetch, useRequestHeaders, useRuntimeConfig, useState } from '#imports'
import { ACCESS_KEY } from '../keys'
import { createLukkFetch, createRequestFetch, type LukkFetchDeps, type RequestFetch } from '../utils/create-lukk-fetch'

interface PublicLukk {
  mode: 'bff' | 'direct'
  apiBaseURL: string
}

/**
 * An auth-aware fetch for your OWN app API — the piece a plain `$fetch` gets wrong
 * (it forwards no cookie in SSR → a silent 401). Transport-aware:
 *
 *  - **BFF**: same-origin to the proxy mount. On the client the interceptor forwards
 *    only `cookie`; on SSR it routes through Nuxt's request-aware fetch, which resolves
 *    the relative mount in-process and forwards the request headers to our own proxy —
 *    which strips everything but the session and injects the bearer server-side.
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

  const deps: LukkFetchDeps = {
    baseURL: cfg.apiBaseURL,
    isServer: import.meta.server === true,
    // Direct mode holds the token in client memory; SSR has none, so nothing to refresh.
    canRefresh: isDirect && import.meta.client === true,
    getCookieHeader: () => cookie,
    getBearer: () => (isDirect ? access.value : null),
    refresh: () => nuxtApp.$lukkRefresh?.() ?? Promise.resolve(null),
    // `external: true` opts out of Nuxt's absolute-URL block, so contain it ourselves: only follow
    // a redirect that stays on the API's own origin. Unreachable today (the browser sees an opaque
    // redirect, and the BFF proxy turns an upstream 3xx into a 502) — but this is the one place a
    // server-controlled string becomes a navigation, and it shouldn't rely on the callers.
    onRedirect: location => isSameOrigin(cfg.apiBaseURL, location) ? navigateTo(location, { external: true }) : undefined,
    fetchImpl: ofetch,
  }

  // Server + BFF: the relative proxy mount can't be fetched by plain ofetch, and a
  // request-derived absolute origin would be `Host`-spoofable. Route through Nuxt's
  // request-aware fetch, which resolves the relative URL in-process (no network egress,
  // no Host dependency) and forwards the session cookie to our own proxy.
  // Server-only glue; the routing itself is covered by createRequestFetch's tests.
  /* v8 ignore next 3 */
  if (import.meta.server === true && cfg.mode === 'bff') {
    return createRequestFetch(useRequestFetch() as unknown as RequestFetch, deps)
  }

  return createLukkFetch(deps)
}

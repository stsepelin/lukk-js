import type { $Fetch, FetchContext, FetchOptions } from 'ofetch'
// Reuse core's guard + error builder so the same-origin check and the LukkError shape
// stay identical across the two transports (no drift on a security-critical path).
import { carriesOrigin, isSameOrigin, lukkError } from 'lukk-core'

export interface LukkFetchDeps {
  /** App-API base — the same-origin proxy mount (BFF) or the API URL (direct). */
  baseURL: string
  /** True during SSR — forward the request cookie, don't rely on the browser. */
  isServer: boolean
  /** Direct mode with an in-memory token: enables single-flight 401 refresh + retry. */
  canRefresh: boolean
  /** SSR: the inbound request's `cookie` header (BFF session). Client: undefined. */
  getCookieHeader: () => string | undefined
  /** Direct mode: the in-memory access token. BFF: null (the proxy injects it). */
  getBearer: () => string | null
  /** Single-flight token refresh (shared with `$lukk`); resolves truthy on success. */
  refresh: () => Promise<unknown>
  /** This app's own origin, where it is known — for judging an absolute URL against a relative base. */
  origin?: string
  /** Surface an upstream redirect instead of silently following it. */
  onRedirect: (location: string) => void
  /** The ofetch base (injectable for tests). */
  fetchImpl: $Fetch
}

/** A 3xx that `redirect: 'manual'` left unfollowed (or a browser opaque redirect). */
function redirectLocation(response: Response): string | null {
  if (response.type === 'opaqueredirect') return null // browser hides the target
  if (response.status >= 300 && response.status < 400) return response.headers.get('location')
  return null
}

/**
 * The auth-aware ofetch options — shared by the client/direct instance (via
 * `createLukkFetch`) and the server-BFF path (passed as init to Nuxt's request-aware
 * fetch). Transport-aware: BFF forwards the sealed session cookie on SSR (only `cookie`,
 * never `authorization`/`x-forwarded-*`); direct attaches the in-memory bearer and
 * single-flights a 401 refresh-and-retry. Always JSON, `redirect: 'manual'`, and rejects
 * with a typed `LukkError`.
 */
export function lukkFetchOptions(deps: LukkFetchDeps): FetchOptions {
  return {
    baseURL: deps.baseURL,
    // `same-origin`, upgraded to `include` by the hook below once the target is known to be same-origin as
    // the API base. The other way round fails OPEN: ofetch merges per-call options by spreading, so a
    // caller's own `onRequest` replaces ours — and a cross-origin URL would then keep `include` and carry
    // that origin's cookies.
    credentials: 'same-origin',
    redirect: 'manual',
    // Direct mode: let ofetch retry a 401 once — the refresh runs in onResponseError
    // first, so the retry's onRequest reads the fresh token. BFF refreshes in the proxy.
    retry: deps.canRefresh ? 1 : 0,
    retryStatusCodes: [401],
    onRequest(ctx) {
      const { options } = ctx
      // `redirect` pinned HERE, not only in the instance defaults, because ofetch spreads per-call
      // options over those: a caller passing `redirect: 'follow'` re-enabled chasing a 3xx, and a
      // 307/308 preserves the METHOD AND BODY across origins (RFC 9110 §15.4.8-9). The browser strips
      // `Authorization` on a cross-origin redirect but not a credential in the body. Both siblings —
      // `createRequestFetch` and lukk-core's `request()` — already pin it after the caller's options.
      options.redirect = 'manual'
      const headers = new Headers(options.headers)
      headers.set('accept', 'application/json')

      // Never attach the sealed session cookie / bearer to a cross-origin target a
      // caller may have passed — and drop `credentials` there too.
      const url = typeof ctx.request === 'string' ? ctx.request : ctx.request.url
      const sameOrigin = targetIsOurs(deps, url, options.baseURL)
      options.credentials = sameOrigin ? 'include' : 'same-origin'
      if (sameOrigin) {
        if (deps.isServer) {
          const cookie = deps.getCookieHeader()
          if (cookie) headers.set('cookie', cookie)
        }
        const bearer = deps.getBearer()
        if (bearer) headers.set('authorization', `Bearer ${bearer}`)
      }
      options.headers = headers
    },
    onResponse({ response }) {
      const location = redirectLocation(response)
      if (location) deps.onRedirect(location)
    },
    async onResponseError(ctx: FetchContext & { response: Response & { _data?: unknown } }) {
      const retryable = deps.canRefresh && ctx.response.status === 401
        && ctx.options.retry !== 0 && ctx.options.retry !== false
      // Refresh (single-flight); on success don't throw, so ofetch retries with the
      // fresh token. On a failed refresh, fall through to the typed error (no wasted retry).
      if (retryable && await deps.refresh()) {
        return
      }
      throw lukkError(ctx.response.status, ctx.response.statusText, ctx.response._data as { message?: string, errors?: Record<string, string[]> })
    },
  }
}

/** The client/direct instance: an ofetch instance carrying the shared options. */
export function createLukkFetch(deps: LukkFetchDeps): $Fetch {
  return deps.fetchImpl.create(lukkFetchOptions(deps))
}

/**
 * The server-BFF instance: routes each call through Nuxt's request-aware fetch (which
 * resolves the relative mount in-process and forwards the session cookie), carrying the
 * shared auth-aware options.
 */
/**
 * Is this request staying on the API — the only place a lukk credential may go?
 *
 * Shared by the `onRequest` hook and by `createRequestFetch`, because the two MUST agree: the hook was
 * the only caller once, and the request-aware transport underneath it attached the inbound cookie to a
 * foreign host before the hook ever ran.
 */
function targetIsOurs(deps: LukkFetchDeps, url: string, baseURL: unknown): boolean {
  // The per-call `baseURL` counts too: ofetch applies it AFTER the hook, so checking the request alone
  // would clear a relative path as same-origin and then send the bearer to the caller's own origin.
  //
  // An EMPTY base is not a relative one. It is ofetch's idiom for "take this path exactly as given",
  // which `loadUser` passes so a configured absolute `user.endpoint` survives. Reading it as relative
  // refused the bearer on every direct-mode app whose API base is absolute — which is every ordinary
  // one — so login succeeded and the user then never loaded, burning a rotation per retry.
  const declared = typeof baseURL === 'string' ? baseURL : undefined
  const perCall = declared === '' ? undefined : declared
  const known = (base: string | undefined, target: string) => base !== undefined && isSameOrigin(base, target)
  const apiIsRelative = !/^https?:\/\//i.test(deps.baseURL)
  // This app's own origin stands in for the API's ONLY where the API base is the relative proxy mount:
  // there `isSameOrigin` refuses every absolute URL, and same-origin is exactly what the mount means.
  // With an ABSOLUTE API base the app's origin is a different host that the bearer was never scoped
  // to — and on the server this origin comes from the `Host` header, so it is not ours to trust.
  const appOrigin = apiIsRelative ? deps.origin : undefined
  const perCallOk = perCall === undefined
    ? true
    : carriesOrigin(perCall)
      // Absolute: the API's own origin, or this app's under the proxy mount. Unknown origin (SSR
      // without a request URL) stays refused.
      ? isSameOrigin(deps.baseURL, perCall) || known(appOrigin, perCall)
      // Relative: it resolves against the DOCUMENT, so it only stays on the API when the API is this
      // app (a relative base). With an absolute API base it points somewhere else entirely.
      : apiIsRelative

  return (isSameOrigin(deps.baseURL, url) || known(appOrigin, url)) && perCallOk
}

/** Minimal callable shape of Nuxt's request-aware fetch that we drive. */
export type RequestFetch = (request: string, opts?: FetchOptions) => Promise<unknown>

export function createRequestFetch(requestFetch: RequestFetch, deps: LukkFetchDeps): $Fetch {
  const options = lukkFetchOptions(deps)
  // `redirect` sits AFTER the caller's opts, mirroring `lukk-core`'s ordering: a caller passing
  // `redirect: 'follow'` would otherwise re-enable chasing a 3xx, and this fetch attaches the
  // sealed session cookie on the server.
  return ((request: string, opts: FetchOptions = {}) => {
    // Nuxt's request-aware fetch is h3's `fetchWithEvent`, which merges `getProxyRequestHeaders(event)`
    // — the visitor's whole inbound `Cookie` among them — into EVERY request, absolute targets
    // included, and does it before ofetch runs our `onRequest`. So the hook's guard was computing the
    // right answer over a credential the transport had already attached: on SSR, handing
    // `useLukkFetch()` an absolute URL derived from request input sent the sealed BFF session to that
    // host, with no CORS in the way. Blank it here, where it is still ours to blank.
    const ours = targetIsOurs(deps, request, opts.baseURL ?? options.baseURL)
    const headers = ours ? opts.headers : { ...(opts.headers as Record<string, string> | undefined), cookie: '' }

    return requestFetch(request, { ...options, ...opts, headers, redirect: 'manual' })
  }) as $Fetch
}

import {
  addImportsDir,
  addPlugin,
  addRouteMiddleware,
  addServerHandler,
  addServerImportsDir,
  createResolver,
  defineNuxtModule,
} from '@nuxt/kit'
import { defu } from 'defu'
import type { LukkMode } from 'lukk-core'
import { LUKK_BFF_PREFIX, isResolvableBase, isUsableConfirmationHeader, redactCredentials } from './runtime/shared'

export { LUKK_BFF_PREFIX, LUKK_SESSION_COOKIE } from './runtime/shared'

/**
 * The origin of an absolute URL (drops any path, e.g. lukk's `/auth` prefix). A validated
 * root-relative base (direct mode) has no origin to take — the app's own is `''` for a
 * same-origin fetch, and returning the path verbatim would aim the app API at lukk's prefix.
 */
function originOf(url: string): string {
  try { return new URL(url).origin }
  catch { return '' }
}

/** A same-origin base the BROWSER resolves against the page (`direct` mode only). */
function isRootRelative(value: string): boolean {
  return value.startsWith('/') && !value.startsWith('//')
}

/** Whether a URL points at this machine — a dev value that shouldn't reach a production build. */
function isLoopback(url: string): boolean {
  try {
    // `URL.hostname` keeps IPv6 brackets and lowercases, so `[::1]` is the form that ever matches.
    const { hostname } = new URL(url)
    return hostname === 'localhost' || hostname.endsWith('.localhost')
      || /^127\./.test(hostname) || hostname === '[::1]' || hostname === '0.0.0.0'
  }
  catch {
    return false
  }
}

/** A base whose query/fragment would swallow the request path (`/auth?x=1` + `/login`). */
function carriesQueryOrFragment(url: string): boolean {
  try {
    const { search, hash } = new URL(url)
    return !!search || !!hash
  }
  catch {
    return false
  }
}

/**
 * Fail the BUILD on a base URL that could never work, instead of letting it surface as an opaque
 * request-time `400` (which reads as a routing bug, not a config one). The classic fault is an
 * unset build-time env var interpolating into a template string as `"undefined/auth"` — a
 * non-empty string, so a falsiness check misses it, and it's baked into the bundle, so it's
 * knowable here. See `isResolvableBase` for why a bare `new URL()` isn't enough.
 *
 * `relativeOk` covers the browser-resolved bases (`direct` mode), where a root-relative `/auth`
 * is a legitimate same-origin setup. A server-fetched base has no valid relative form.
 */
function baseError(value: string, label: string, relativeOk: boolean): string | null {
  if (!isResolvableBase(value) && !(relativeOk && isRootRelative(value))) {
    return `[lukk-nuxt] ${label} "${redactCredentials(value)}" is not a valid absolute URL. It must start with http:// or https://`
      + `${relativeOk ? ', or be a root-relative path like "/auth"' : ''}. `
      + 'A common cause is an unset build-time env var interpolating as "undefined" '
      + '(e.g. `${process.env.API_URL}/auth`). If you build once and supply the URL per environment, '
      + 'leave it empty and set NUXT_LUKK_BASE_URL at runtime instead.'
  }
  // The request path is appended to the base, so a query/fragment absorbs it: `/auth?t=1` + `/login`
  // resolves to `/auth?t=1/login`, meaning every route silently hits the same upstream endpoint —
  // including `/logout`, which would clear the local session while the token family stays live.
  // Unlike a loopback base, this has no legitimate use, so it's an error rather than a warning.
  if (carriesQueryOrFragment(value)) {
    return `[lukk-nuxt] ${label} "${redactCredentials(value)}" carries a query or fragment. `
      + 'The request path is appended after it, so every call would resolve to the wrong URL. '
      + 'Use only the scheme, host and path.'
  }
  return null
}

export interface ModuleOptions {
  /** lukk base URL incl. the route prefix, e.g. `https://api.example.com/auth`. */
  baseURL: string
  /**
   * Transport. `bff` proxies through Nitro (tokens stay server-side; needs a
   * runtime server). `direct` calls lukk from the client (works for SSG/SPA).
   * @default 'bff'
   */
  mode: LukkMode
  /**
   * BFF only: hydrate `useLukkAuth().user` on the server so authenticated pages render
   * logged-in on the first paint (no logged-out→logged-in flash, no `<ClientOnly>`). The
   * server reads the sealed session and seeds the user resource into the SSR payload — the
   * token itself never leaves the server, and the render is marked `no-store`. Set `false`
   * to keep the pre-0.4 client-only behavior. No effect in `direct` mode (no server session).
   * @default true
   */
  ssrHydrate: boolean
  /** Header carrying the step-up token. @default 'X-Lukk-Confirmation' */
  confirmationHeader: string
  /**
   * BFF token storage. `cookie` = stateless sealed session (default, no infra);
   * or a Nitro `useStorage` mount name for a server-side store.
   * @default 'cookie'
   */
  storage: string
  /**
   * Your app's authenticated user endpoint (lukk issues the token; your app owns
   * the user resource), fetched to populate `useLukkAuth().user`.
   *  - direct: an absolute URL or path; the access token is attached as a Bearer.
   *  - bff: MUST be a **same-origin path authenticated server-side** — the app-API
   *    proxy (`api` below), or your own route using `getLukkAccessToken(event)`.
   *    The browser holds no token to attach.
   *
   * `key` (default `'data'`) unwraps a wrapper around the user — lukk auto-unwraps a clean
   * Laravel API-Resource `{ "data": {...} }` (never a paginated/error envelope). Set a different
   * key for another wrapper, or `false` to disable unwrapping and store the response as-is.
   */
  user: { endpoint: string, key?: string | false }
  /**
   * BFF only: the secret that seals the server-side token session (≥ 32 chars).
   * Prefer setting it via the `NUXT_LUKK_SESSION_PASSWORD` env var.
   *
   * `cookieSecure` controls the session cookie's Secure attribute (and, by extension,
   * the `__Host-` name prefix, which requires Secure). It defaults to: Secure in a
   * production build, Secure under `nuxi dev --https`, and NOT Secure for `nuxi dev`
   * over plain http (a browser drops a Secure cookie even on localhost, so the session
   * wouldn't persist). Set it explicitly only for an unusual setup (e.g. dev behind
   * your own TLS proxy). Never ship `false` to production.
   *
   * `name` namespaces the session cookie so multiple lukk apps can share a host without
   * clobbering each other's session — cookies are scoped by host, not port, so dev on
   * `localhost:3000` + `:3001` (or two apps under one domain via path routing) collide on
   * the same cookie. Set a distinct slug per app (`[A-Za-z0-9._-]`):
   * `name: 'admin'` → `__Host-lukk-admin-session` (Secure) / `lukk-admin-session` (dev http).
   * Unset keeps the default `__Host-lukk-session` / `lukk-session`.
   *
   * This is de-confliction for co-hosted apps, NOT a trust boundary: apps sharing an origin
   * (same host + path routing, or `localhost` across ports) share one cookie jar. Put distinct-
   * trust apps on separate subdomains — where `__Host-` + the host-level Origin check give real
   * isolation — and give each app a distinct strong `session.password`; the seal password, not the
   * name, is the isolation boundary.
   */
  session: { password: string, cookieSecure?: boolean, name?: string }
  /**
   * BFF only, optional: proxy your own app API so it's authenticated out of the
   * box. Requests to `${path}/**` are forwarded to the FIXED `target` (your
   * Laravel API) with the access token injected server-side — the browser never
   * holds a token. `target` is never derived from the request (SSRF-safe).
   * @example { path: '/api', target: 'https://api.example.com' }
   *
   * `forceJson` (default `true`) sets `Accept: application/json` on forwarded
   * requests, so a JSON API renders clean `401`/`422` JSON for unauthenticated /
   * validation errors instead of Laravel's default guest-redirect (which 500s
   * behind a proxy). Set `false` to forward the browser's `Accept` instead — only
   * if a route under `path` legitimately serves a non-JSON response.
   *
   * `forwardSetCookie` (default `[]`) is an allow-list of **cookie names** the proxy
   * will pass through from your app API to the browser. By default the proxy owns
   * cookies and strips every upstream `Set-Cookie`; list a name here to let a hybrid
   * app's own cookie (a locale, a feature flag) reach the browser. The sealed session
   * cookie is never forwardable regardless of this list.
   */
  api: { path: string, target: string, forceJson: boolean, forwardSetCookie: string[] }
  /**
   * BFF only, opt-in: the request header your TRUSTED edge sets with the real client IP
   * (`'cf-connecting-ip'`, `'x-real-ip'`, …). Both proxies then forward that address upstream as
   * `X-Forwarded-For`, so your API can identify the visitor.
   *
   * Unset (the default) every browser-settable forwarding header is blanked and the socket address
   * is forwarded instead — safe, but behind ANY reverse proxy that address is the proxy, so an
   * upstream keying rate limits on it throttles all visitors as one identity (`throttle:5,1`
   * becomes 5/min globally). Enable this only when a hop you control sets the header.
   *
   * It must be a header your edge **sets**, overwriting whatever the client sent. One the edge
   * merely appends to (the usual `x-forwarded-for` chain) leaves the leftmost entry
   * client-controlled and is spoofable. The upstream must also trust this hop (Laravel's
   * `TrustProxies`) for `$request->ip()` to read it.
   * @default '' (off)
   */
  clientIpHeader: string
}

export default defineNuxtModule<ModuleOptions>({
  meta: {
    name: 'lukk-nuxt',
    configKey: 'lukk',
    compatibility: { nuxt: '>=3.13.0' },
  },
  defaults: {
    baseURL: '',
    mode: 'bff',
    ssrHydrate: true,
    confirmationHeader: 'X-Lukk-Confirmation',
    storage: 'cookie',
    user: { endpoint: '' },
    session: { password: '' },
    api: { path: '', target: '', forceJson: true, forwardSetCookie: [] },
    clientIpHeader: '',
  },
  setup(options, nuxt) {
    const resolver = createResolver(import.meta.url)
    // Normalize the app-proxy mount once (a trailing slash would make `/api//**`).
    const apiPath = options.api.path.replace(/\/$/, '')

    // Half-configured app-API proxy: one of path/target set without the other. The
    // proxy is only registered when BOTH are present, so this would silently do nothing.
    if (options.mode === 'bff' && !!apiPath !== !!options.api.target) {
      console.warn('[lukk-nuxt] The app-API proxy needs BOTH `api.path` and `api.target` — it was not registered.')
    }

    // The one real footgun in this option: an append-style header keeps the client's own entry
    // leftmost, so trusting it hands `$request->ip()` straight back to the browser — the exact
    // spoofing the default blanking exists to prevent.
    if (options.mode === 'bff' && ['x-forwarded-for', 'forwarded'].includes(options.clientIpHeader.toLowerCase())) {
      console.warn(`[lukk-nuxt] clientIpHeader "${options.clientIpHeader}" is append-style: its leftmost entry is client-controlled, so a visitor can spoof their address. Use one your own edge SETS — cf-connecting-ip behind Cloudflare, or x-real-ip if your nginx sets it.`)
    }

    // Dead config in direct mode: there is no proxy hop, so the browser reaches the API itself and
    // its own address is the one the API sees.
    if (options.mode === 'direct' && options.clientIpHeader) {
      console.warn('[lukk-nuxt] `clientIpHeader` only applies in bff mode — in direct mode the browser calls the API itself, so it has no effect.')
    }

    // A `session.name` with cookie-name separators (`;`, `=`, whitespace, …) would break the cookie.
    if (options.mode === 'bff' && options.session.name && !/^[a-z0-9._-]+$/i.test(options.session.name)) {
      console.warn(`[lukk-nuxt] session.name "${options.session.name}" should be a simple slug ([A-Za-z0-9._-]); other characters can break the session cookie.`)
    }

    // Client-visible config. In BFF mode the browser talks only to our own Nitro
    // proxy, so the lukk URL is NOT exposed to the client.
    nuxt.options.runtimeConfig.public.lukk = defu(nuxt.options.runtimeConfig.public.lukk,
      {
        mode: options.mode,
        confirmationHeader: options.confirmationHeader,
        baseURL: options.mode === 'direct' ? options.baseURL : '',
        userEndpoint: options.user.endpoint,
        // Normalize to a string for runtimeConfig: '' disables unwrapping, else the wrapper key (default 'data').
        userKey: options.user.key === false ? '' : (options.user.key ?? 'data'),
        // App-API base for `useLukkFetch`: the same-origin proxy mount (BFF) or, in
        // direct mode, the configured `api.target` else the lukk **origin** (the
        // `/auth` prefix is dropped — pass full app paths to `useLukkFetch`).
        apiBaseURL: options.mode === 'bff' ? apiPath : (options.api.target || originOf(options.baseURL)),
      },
    )

    // Server-only config (the real lukk URL + storage choice for the BFF proxy,
    // plus the optional app-API proxy target — fixed here, never request-derived).
    // Secure session cookie in production; also under `nuxi dev --https` (detected via
    // the dev-server https config); relaxed only for `nuxi dev` over plain http, where a
    // browser would drop a Secure cookie. Decided once here — the runtime never sniffs
    // the request scheme (no x-forwarded-proto spoofing surface).
    const cookieSecure = options.session.cookieSecure
      ?? (!nuxt.options.dev || Boolean(nuxt.options.devServer?.https))

    nuxt.options.runtimeConfig.lukk = defu(nuxt.options.runtimeConfig.lukk,
      {
        baseURL: options.baseURL,
        storage: options.storage,
        sessionPassword: options.session.password,
        cookieSecure,
        // Per-app namespace (data only). The full cookie NAME is derived at each runtime site from
        // this + the runtime `cookieSecure`, so the `__Host-` prefix and the Secure attribute always
        // come from ONE source and can't diverge under an independent runtime-config override.
        cookieNamespace: options.session.name,
        apiPath,
        apiTarget: options.api.target,
        apiForceJson: options.api.forceJson,
        apiForwardSetCookie: options.api.forwardSetCookie,
        // Canonicalised for readability in the resolved config; h3 lower-cases the lookup itself,
        // so matching does not depend on this.
        clientIpHeader: options.clientIpHeader.toLowerCase(),
      },
    )

    // Validate the EFFECTIVE config, after the merges above — a consumer can set `runtimeConfig`
    // directly and defu gives that precedence, so checking only the module option would bless a
    // value the app never uses. (A runtime `NUXT_*` env override still lands after the build;
    // the proxies report that one honestly at request time.)
    const serverLukk = nuxt.options.runtimeConfig.lukk as { baseURL: string, apiTarget: string }
    const publicLukk = nuxt.options.runtimeConfig.public.lukk as { baseURL: string, apiBaseURL: string }
    // Direct mode's base is browser-resolved (the public copy); BFF's is server-fetched.
    const isDirect = options.mode === 'direct'
    const effectiveBase = isDirect ? publicLukk.baseURL : serverLukk.baseURL

    // `nuxt prepare` runs every module setup just to generate types — the Nuxt starters wire it into
    // `postinstall`, and it legitimately runs before a deploy's secrets exist. Throwing there would
    // make `pnpm install` fail on a fresh clone, so only a real build is fatal.
    const fail = (message: string): void => {
      if (nuxt.options._prepare) return console.error(message)
      throw new Error(message)
    }

    // An empty or non-token value becomes a computed header key that `Headers.set` rejects, 502ing
    // every proxied request; a name the proxies set themselves silently breaks step-up (or, in the
    // auth proxy, clobbers Accept/Content-Type). Both fail loudly here rather than at request time.
    if (!isUsableConfirmationHeader(options.confirmationHeader)) {
      fail(`[lukk-nuxt] confirmationHeader "${options.confirmationHeader}" must be a valid HTTP header name that the proxies don't already set (not Authorization, Accept, Content-Type, Cookie, or a forwarding header). Use a token such as X-Lukk-Confirmation.`)
    }

    // BFF mode seals tokens with this secret; fail loudly at build, not per-request.
    if (options.mode === 'bff') {
      const password = options.session.password || process.env.NUXT_LUKK_SESSION_PASSWORD || ''

      if (!password) {
        console.warn('[lukk-nuxt] BFF mode needs a session secret (≥ 32 chars) — set `session.password` or NUXT_LUKK_SESSION_PASSWORD.')
      }
      // A SHORT password was documented as a requirement and enforced nowhere. iron rejects it at
      // write time, so the old failure mode was safe but awful: every login and refresh 500s, and
      // you find out in production rather than at build.
      // Nothing DERIVED from the secret goes into the message — not even its length. `fail` logs
      // under `nuxt prepare`, and build logs are routinely public (CI, error overlays); leaking the
      // length of a secret narrows a search space for free. CodeQL flags the taint flow too.
      else if (password.length < 32) {
        fail('[lukk-nuxt] the session secret is too short — it must be at least 32 characters. '
          + 'It is the confidentiality boundary for the sealed session cookie, the BFF equivalent of Laravel\'s APP_KEY.')
      }
    }

    if (!effectiveBase) {
      console.warn('[lukk-nuxt] `baseURL` is not set — point it at your lukk auth URL.')
    }
    else {
      const error = baseError(effectiveBase, '`baseURL`', isDirect)
      if (error) fail(error)
      // Legitimate for local prod-mode testing, but also the shape of a dev `.env` reaching a real
      // deploy — where SSR then calls the server's own loopback. Only the operator can tell those
      // apart, so warn rather than throw.
      if (!nuxt.options.dev && isLoopback(effectiveBase)) {
        console.warn(`[lukk-nuxt] \`baseURL\` points at ${originOf(effectiveBase)} in a production build — a dev value may have leaked into this deploy.`)
      }
    }

    // BFF fetches `api.target` server-side through the same `resolveTarget` path as `baseURL`, so
    // it fails identically. In direct mode it's the browser's app-API base instead, where a
    // same-origin `/api` is legitimate — but `"undefined/api"` is just as broken.
    const effectiveTarget = isDirect ? options.api.target : serverLukk.apiTarget
    if (effectiveTarget && (isDirect || apiPath)) {
      const error = baseError(effectiveTarget, '`api.target`', isDirect)
      if (error) fail(error)
    }

    // `apiBaseURL` is what `useLukkFetch` scopes the bearer against (`isSameOrigin`), and it's
    // written through defu — so a consumer setting it directly would otherwise bypass every check
    // above and could aim credentialed requests (cookies + bearer) at another origin.
    if (publicLukk.apiBaseURL) {
      const error = baseError(publicLukk.apiBaseURL, '`api.target` (apiBaseURL)', true)
      if (error) fail(error)
    }

    // `user.endpoint` had no validation at all — not even the `"undefined/me"` unset-env-var check
    // that motivated `baseError`. It is fetched with an EMPTY base, which is the one configuration
    // where a protocol-relative value escapes, and it runs on every authenticated SSR render with
    // the sealed session cookie attached.
    if (options.user.endpoint) {
      const error = baseError(options.user.endpoint, '`user.endpoint`', true)
      if (error) fail(error)
      // In BFF mode it MUST be same-origin: the docblock says so, and an absolute URL there would
      // send the sealed cookie somewhere it was never scoped to.
      if (!isDirect && isResolvableBase(options.user.endpoint)) {
        fail(`[lukk-nuxt] \`user.endpoint\` "${redactCredentials(options.user.endpoint)}" must be a same-origin path in bff mode — `
          + 'it is fetched server-side with the sealed session cookie attached.')
      }
    }

    // BFF deliberately keeps the lukk URL server-side; an override would ship it in the SSR payload.
    if (!isDirect && publicLukk.baseURL) {
      console.warn('[lukk-nuxt] `runtimeConfig.public.lukk.baseURL` is set in bff mode — the lukk URL is meant to stay server-side and will be exposed to the browser.')
    }

    // Auto-imported composables: useLukkAuth, useLukkTwoFactor, useLukkPasskeys, ...
    addImportsDir(resolver.resolve('./runtime/composables'))

    // Server-side helpers for your own routes: getLukkAccessToken(event), useLukkSession(event).
    addServerImportsDir(resolver.resolve('./runtime/server/utils'))

    // Route guards: `lukk-auth` (require login), `lukk-guest` (bounce authed users),
    // `lukk-verified` (require a verified email), `lukk-confirmed` (require step-up confirmation).
    addRouteMiddleware({ name: 'lukk-auth', path: resolver.resolve('./runtime/middleware/auth') })
    addRouteMiddleware({ name: 'lukk-guest', path: resolver.resolve('./runtime/middleware/guest') })
    addRouteMiddleware({ name: 'lukk-verified', path: resolver.resolve('./runtime/middleware/verified') })
    addRouteMiddleware({ name: 'lukk-confirmed', path: resolver.resolve('./runtime/middleware/confirmed') })

    // One client plugin for both modes — only the baseURL/transport differs.
    addPlugin(resolver.resolve('./runtime/plugins/client'))
    // Browser-only: silently restore an existing session on load.
    addPlugin({ src: resolver.resolve('./runtime/plugins/session.client'), mode: 'client' })
    // BFF SSR hydration: seed the user on the server so authed pages render logged-in on the
    // first paint. Default on; opt out with `ssrHydrate: false`. No-op in direct mode.
    if (options.mode === 'bff' && options.ssrHydrate !== false) {
      addPlugin({ src: resolver.resolve('./runtime/plugins/session.server'), mode: 'server' })
    }

    // BFF mode: the same-origin Nitro proxy that holds tokens server-side.
    if (options.mode === 'bff') {
      addServerHandler({ route: `${LUKK_BFF_PREFIX}/**`, handler: resolver.resolve('./runtime/server/bff') })

      // Optional: proxy the app's own API so it's authenticated out of the box.
      if (apiPath && options.api.target) {
        addServerHandler({ route: `${apiPath}/**`, handler: resolver.resolve('./runtime/server/api-proxy') })
      }
    }
  },
})

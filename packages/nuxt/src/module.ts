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
import { LUKK_BFF_PREFIX } from './runtime/shared'

export { LUKK_BFF_PREFIX, LUKK_SESSION_COOKIE } from './runtime/shared'

/** The origin of an absolute URL (drops any path, e.g. lukk's `/auth` prefix). */
function originOf(url: string): string {
  try { return new URL(url).origin }
  catch { return url }
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
   */
  user: { endpoint: string }
  /**
   * BFF only: the secret that seals the server-side token session (≥ 32 chars).
   * Prefer setting it via the `NUXT_LUKK_SESSION_PASSWORD` env var.
   */
  session: { password: string }
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
   */
  api: { path: string, target: string, forceJson: boolean }
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
    confirmationHeader: 'X-Lukk-Confirmation',
    storage: 'cookie',
    user: { endpoint: '' },
    session: { password: '' },
    api: { path: '', target: '', forceJson: true },
  },
  setup(options, nuxt) {
    const resolver = createResolver(import.meta.url)
    // Normalize the app-proxy mount once (a trailing slash would make `/api//**`).
    const apiPath = options.api.path.replace(/\/$/, '')

    if (!options.baseURL) {
      console.warn('[lukk-nuxt] `baseURL` is not set — point it at your lukk auth URL.')
    }

    // BFF mode seals tokens with this secret; fail loudly at build, not per-request.
    if (options.mode === 'bff' && !options.session.password && !process.env.NUXT_LUKK_SESSION_PASSWORD) {
      console.warn('[lukk-nuxt] BFF mode needs a session secret (≥ 32 chars) — set `session.password` or NUXT_LUKK_SESSION_PASSWORD.')
    }

    // Half-configured app-API proxy: one of path/target set without the other. The
    // proxy is only registered when BOTH are present, so this would silently do nothing.
    if (options.mode === 'bff' && !!apiPath !== !!options.api.target) {
      console.warn('[lukk-nuxt] The app-API proxy needs BOTH `api.path` and `api.target` — it was not registered.')
    }

    // Client-visible config. In BFF mode the browser talks only to our own Nitro
    // proxy, so the lukk URL is NOT exposed to the client.
    nuxt.options.runtimeConfig.public.lukk = defu(nuxt.options.runtimeConfig.public.lukk,
      {
        mode: options.mode,
        confirmationHeader: options.confirmationHeader,
        baseURL: options.mode === 'direct' ? options.baseURL : '',
        userEndpoint: options.user.endpoint,
        // App-API base for `useLukkFetch`: the same-origin proxy mount (BFF) or, in
        // direct mode, the configured `api.target` else the lukk **origin** (the
        // `/auth` prefix is dropped — pass full app paths to `useLukkFetch`).
        apiBaseURL: options.mode === 'bff' ? apiPath : (options.api.target || originOf(options.baseURL)),
      },
    )

    // Server-only config (the real lukk URL + storage choice for the BFF proxy,
    // plus the optional app-API proxy target — fixed here, never request-derived).
    nuxt.options.runtimeConfig.lukk = defu(nuxt.options.runtimeConfig.lukk,
      {
        baseURL: options.baseURL,
        storage: options.storage,
        sessionPassword: options.session.password,
        apiPath,
        apiTarget: options.api.target,
        apiForceJson: options.api.forceJson,
      },
    )

    // Auto-imported composables: useLukkAuth, useLukkTwoFactor, useLukkPasskeys, ...
    addImportsDir(resolver.resolve('./runtime/composables'))

    // Server-side helpers for your own routes: getLukkAccessToken(event), useLukkSession(event).
    addServerImportsDir(resolver.resolve('./runtime/server/utils'))

    // Route guards: `lukk-auth` (require login) and `lukk-guest` (bounce authed users).
    addRouteMiddleware({ name: 'lukk-auth', path: resolver.resolve('./runtime/middleware/auth') })
    addRouteMiddleware({ name: 'lukk-guest', path: resolver.resolve('./runtime/middleware/guest') })

    // One client plugin for both modes — only the baseURL/transport differs.
    addPlugin(resolver.resolve('./runtime/plugins/client'))
    // Browser-only: silently restore an existing session on load.
    addPlugin({ src: resolver.resolve('./runtime/plugins/session.client'), mode: 'client' })

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

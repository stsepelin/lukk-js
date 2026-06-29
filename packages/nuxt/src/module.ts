import {
  addImportsDir,
  addPlugin,
  addRouteMiddleware,
  addServerHandler,
  createResolver,
  defineNuxtModule,
} from '@nuxt/kit'
import { defu } from 'defu'
import type { LukkMode } from 'lukk-core'

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
   * the user resource). Fetched with the access token to populate
   * `useLukkAuth().user`. An absolute URL, or a path resolved against the app.
   */
  user: { endpoint: string }
  /**
   * BFF only: the secret that seals the server-side token session (≥ 32 chars).
   * Prefer setting it via the `NUXT_LUKK_SESSION_PASSWORD` env var.
   */
  session: { password: string }
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
  },
  setup(options, nuxt) {
    const resolver = createResolver(import.meta.url)

    if (!options.baseURL) {
      console.warn('[lukk-nuxt] `baseURL` is not set — point it at your lukk auth URL.')
    }

    // BFF mode seals tokens with this secret; fail loudly at build, not per-request.
    if (options.mode === 'bff' && !options.session.password && !process.env.NUXT_LUKK_SESSION_PASSWORD) {
      console.warn('[lukk-nuxt] BFF mode needs a session secret (≥ 32 chars) — set `session.password` or NUXT_LUKK_SESSION_PASSWORD.')
    }

    // Client-visible config. In BFF mode the browser talks only to our own Nitro
    // proxy, so the lukk URL is NOT exposed to the client.
    nuxt.options.runtimeConfig.public.lukk = defu(nuxt.options.runtimeConfig.public.lukk,
      {
        mode: options.mode,
        confirmationHeader: options.confirmationHeader,
        baseURL: options.mode === 'direct' ? options.baseURL : '',
        userEndpoint: options.user.endpoint,
      },
    )

    // Server-only config (the real lukk URL + storage choice for the BFF proxy).
    nuxt.options.runtimeConfig.lukk = defu(nuxt.options.runtimeConfig.lukk,
      { baseURL: options.baseURL, storage: options.storage, sessionPassword: options.session.password },
    )

    // Auto-imported composables: useLukkAuth, useLukkTwoFactor, useLukkPasskeys, ...
    addImportsDir(resolver.resolve('./runtime/composables'))

    // Route guards: `lukk-auth` (require login) and `lukk-guest` (bounce authed users).
    addRouteMiddleware({ name: 'lukk-auth', path: resolver.resolve('./runtime/middleware/auth') })
    addRouteMiddleware({ name: 'lukk-guest', path: resolver.resolve('./runtime/middleware/guest') })

    // One client plugin for both modes — only the baseURL/transport differs.
    addPlugin(resolver.resolve('./runtime/plugins/client'))
    // Browser-only: silently restore an existing session on load.
    addPlugin({ src: resolver.resolve('./runtime/plugins/session.client'), mode: 'client' })

    // BFF mode: the same-origin Nitro proxy that holds tokens server-side.
    if (options.mode === 'bff') {
      addServerHandler({ route: '/api/_lukk/**', handler: resolver.resolve('./runtime/server/bff') })
    }
  },
})

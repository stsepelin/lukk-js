// E2E app: lukk-nuxt in BFF mode, same-origin. The browser talks only to this
// Nuxt server; tokens live server-side in the sealed session, and /api/** (incl.
// the user endpoint) is proxied to the real lukk API with the bearer injected.
export default defineNuxtConfig({
  modules: ['lukk-nuxt'],
  compatibilityDate: '2025-01-01',

  lukk: {
    // The real lukk API (the conformance fixture). Reached only server-side in BFF mode.
    baseURL: process.env.NUXT_LUKK_BASE_URL ?? 'http://127.0.0.1:8000/auth',
    mode: 'bff',
    // SSR hydration on: an authenticated page renders logged-in on the first paint.
    ssrHydrate: true,
    session: {
      // ≥32 chars. Fixed here for the throwaway E2E app; use NUXT_LUKK_SESSION_PASSWORD in real apps.
      password: process.env.NUXT_LUKK_SESSION_PASSWORD ?? 'e2e-conformance-session-password-32ch',
    },
    // App-API proxy: /api/** → the lukk API origin, bearer injected server-side.
    api: {
      path: '/api',
      target: process.env.NUXT_LUKK_API_TARGET ?? 'http://127.0.0.1:8000',
    },
    // Fetched (through the proxy) to populate useLukkAuth().user for SSR hydration.
    user: { endpoint: '/api/user' },
  },
})

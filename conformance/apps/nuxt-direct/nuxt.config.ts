// E2E app: lukk-nuxt in DIRECT mode (no BFF proxy). The client calls lukk directly
// and holds the access token in memory; refresh rides the __Host- cookie. lukk-core
// only attaches the bearer/cookie to a same-origin baseURL (a deliberate anti-leak
// invariant), so direct mode is same-origin: the harness serves this SPA and the lukk
// API under ONE https origin via a path-routing proxy (conformance/serve-direct.mjs).
//
// SPA: `nuxi build` (ssr:false). SSG: `nuxi generate` (same config, prerendered).
export default defineNuxtConfig({
  modules: ['lukk-nuxt'],
  ssr: false,
  compatibilityDate: '2025-01-01',

  lukk: {
    baseURL: '/auth', // same-origin path under the unified proxy origin
    mode: 'direct',
    user: { endpoint: '/user' }, // same-origin; the bearer is attached client-side
  },
})

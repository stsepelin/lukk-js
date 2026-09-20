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
    // Same origin either way — the anti-leak invariant requires it — but the two SHAPES take different
    // paths through the credential rule: a relative base makes `apiBaseURL` relative, an absolute one
    // (what `docs/configuration.md` shows, and what an app with lukk on its own host writes) makes it
    // absolute. Only the absolute shape reaches the check that judges `loadUser`'s empty per-call base,
    // and while every direct topology here was relative, a bug that broke user loading outright on every
    // ordinary direct install passed the whole suite. The runner builds each mode with one of the two.
    baseURL: process.env.E2E_LUKK_BASE_URL || '/auth',
    mode: 'direct',
    user: { endpoint: '/user' }, // same-origin; the bearer is attached client-side
  },
})

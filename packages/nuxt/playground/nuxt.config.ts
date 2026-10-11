// `LUKK_PLAYGROUND_MODE=bff` switches the transport — `pnpm typecheck` checks the module's runtime under both,
// since `useNuxtApp().$lukk` is typed by mode and only bff narrows it.
const bff = process.env.LUKK_PLAYGROUND_MODE === 'bff'

export default defineNuxtConfig({
  modules: ['../src/module'],

  devtools: { enabled: true },
  compatibilityDate: '2025-01-01',

  lukk: {
    // Point at a running lukk instance (the conformance fixture, or your app).
    baseURL: process.env.LUKK_URL ?? 'http://localhost:8000/auth',
    // 'direct' works without a backend session; switch to 'bff' to try the proxy.
    mode: bff ? 'bff' : 'direct',
    // Your app's authenticated user route (returns the current user) — a same-origin path in bff mode, which
    // fetches it server-side with the sealed session.
    user: { endpoint: bff ? '/api/me' : process.env.LUKK_USER_URL ?? 'http://localhost:8000/api/me' },
  },
})

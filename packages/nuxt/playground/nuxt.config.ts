export default defineNuxtConfig({
  modules: ['../src/module'],

  devtools: { enabled: true },
  compatibilityDate: '2025-01-01',

  lukk: {
    // Point at a running lukk instance (the conformance fixture, or your app).
    baseURL: process.env.LUKK_URL ?? 'http://localhost:8000/auth',
    // 'direct' works without a backend session; switch to 'bff' to try the proxy.
    mode: 'direct',
    // Your app's authenticated user route (returns the current user).
    user: { endpoint: process.env.LUKK_USER_URL ?? 'http://localhost:8000/api/me' },
  },
})

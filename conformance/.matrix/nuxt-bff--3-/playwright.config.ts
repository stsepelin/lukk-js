import { defineConfig, devices } from '@playwright/test'

// Drives the Nuxt BFF app in a real browser against a running lukk API (booted by
// conformance/browser.sh). Serves over HTTPS on `localhost` so the browser accepts
// lukk's Secure __Host- sealed session cookie (it will not persist over plain http).
// The API base/target are baked from nuxt.config defaults (127.0.0.1:8000).
// Port 3100 (not 3000) to dodge common local squatters (OrbStack/other dev servers).
const PORT = Number(process.env.E2E_PORT ?? 3100)
const HOST = 'localhost'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  use: {
    baseURL: `https://${HOST}:${PORT}`,
    ignoreHTTPSErrors: true, // self-signed E2E cert
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    // Production Nitro preview behind a tiny HTTPS proxy (see e2e/serve.mjs) —
    // stable prod build + TLS for the Secure session cookie.
    command: 'node e2e/serve.mjs',
    url: `https://${HOST}:${PORT}/`,
    timeout: 120_000,
    reuseExistingServer: false,
    ignoreHTTPSErrors: true,
  },
})

import { defineConfig, devices } from '@playwright/test'

// Direct-mode SPA/SSG behind the unifying HTTPS proxy (see e2e/serve-direct.mjs):
// the app and the lukk API share one origin, so lukk-core attaches the bearer and
// the Secure __Host- refresh cookie works. E2E_APP_MODE (spa|ssg) is passed by the runner.
const PORT = Number(process.env.E2E_PORT ?? 8443)
const HOST = 'localhost'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  use: {
    baseURL: `https://${HOST}:${PORT}`,
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node e2e/serve-direct.mjs',
    url: `https://${HOST}:${PORT}/`,
    timeout: 120_000,
    reuseExistingServer: false,
    ignoreHTTPSErrors: true,
  },
})

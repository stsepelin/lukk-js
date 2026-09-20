import { totp } from '../../../../packages/core/conformance/authenticator'
import { expect, test } from '@playwright/test'

// BFF + SSR, same-origin. The browser talks only to the Nuxt server; tokens live
// server-side in the sealed session. These run against the real lukk API + the
// real lukk-nuxt BFF proxy — no mocks. See conformance/browser.sh.
const USER = 'user@example.com'
const TWO_FACTOR_USER = '2fa@example.com'
const UNVERIFIED_USER = 'unverified@example.com'
const TWO_FACTOR_SECRET = 'JBSWY3DPEHPK3PXP' // matches the fixture seed
const PASSWORD = 'password'
// The lukk API origin (server-side upstream) — for the test-only fixture route that
// hands back the mailed verification link.
const API_ROOT = process.env.LUKK_API_ROOT ?? 'http://127.0.0.1:8000'

// Diagnostics: surface browser console errors + every /api/* response status so a
// flaky failure is explainable from the log. Enabled with E2E_DEBUG=1.
test.beforeEach(({ page }) => {
  if (!process.env.E2E_DEBUG) return
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[console.${m.type()}] ${m.text()}`) })
  page.on('pageerror', e => console.log(`[pageerror] ${e.message}`))
  page.on('request', (r) => { if (r.url().includes('/login')) console.log(`[request] ${r.method()} ${r.url()} ct=${r.headers()['content-type']} body=${r.postData()}`) })
  page.on('response', async (r) => {
    if (!r.url().includes('/api/')) return
    let extra = ''
    if (r.url().includes('/login')) extra = ` body=${await r.text().catch(() => '?')}`
    console.log(`[response] ${r.status()} ${r.request().method()} ${r.url()}${extra}`)
  })
})

type Page = import('@playwright/test').Page

// Navigate AND wait for client hydration — interacting before v-model listeners
// attach would submit stale (empty) reactive values on a cold SSR paint.
async function visit(page: Page, path: string) {
  await page.goto(path)
  await page.waitForSelector('html[data-hydrated="1"]')
}

async function login(page: Page, email: string, password = PASSWORD) {
  await visit(page, '/login')
  await page.getByTestId('email').fill(email)
  await page.getByTestId('password').fill(password)
  await page.getByTestId('submit').click()
}

test('the auth guard redirects an unauthenticated visitor away from a protected page', async ({ page }) => {
  await page.goto('/dashboard')
  await expect(page).toHaveURL(/\/login$/)
  await expect(page.getByTestId('email')).toBeVisible()
})

test('password login establishes a session and loads the user', async ({ page }) => {
  await login(page, USER)
  await expect(page).toHaveURL(/\/dashboard$/)
  await expect(page.getByTestId('user-email')).toHaveText(USER)
  await expect(page.getByTestId('user-verified')).toHaveText('true')
})

test('SSR hydration: the server-rendered HTML already contains the user (no logged-out flash)', async ({ page }) => {
  // Establish the sealed session in the browser context.
  await login(page, USER)
  await expect(page).toHaveURL(/\/dashboard$/)

  // Fetch the protected page's RAW HTML (shares the context's session cookie). If the
  // user is present in the pre-hydration markup, the server seeded it — not the client.
  const res = await page.request.get('/dashboard')
  const html = await res.text()
  expect(html).toContain(USER)

  // The home page's SSR HTML reflects the authenticated state too.
  const home = await (await page.request.get('/')).text()
  expect(home).toContain('authenticated')
})

test('the session persists across a full reload', async ({ page }) => {
  await login(page, USER)
  // Let login fully settle before reloading — otherwise the reload aborts the
  // in-flight post-login navigation/user-fetch and the session never establishes.
  await expect(page).toHaveURL(/\/dashboard$/)
  await visit(page, '/')
  await expect(page.getByTestId('auth-state')).toHaveText('authenticated')
  await expect(page.getByTestId('user-email')).toHaveText(USER)
})

test('logout clears the session and re-locks protected pages', async ({ page }) => {
  await login(page, USER)
  await expect(page).toHaveURL(/\/dashboard$/)
  await page.getByTestId('logout').click()
  await expect(page).toHaveURL(/\/login$/)

  // Protected page is locked again.
  await page.goto('/dashboard')
  await expect(page).toHaveURL(/\/login$/)
})

test('a 2FA user is challenged, then completes login with a TOTP code', async ({ page }) => {
  await login(page, TWO_FACTOR_USER)
  // No session yet — a challenge form instead.
  await expect(page.getByTestId('two-factor-prompt')).toBeVisible()
  await expect(page).toHaveURL(/\/login$/)

  await page.getByTestId('totp-code').fill(totp(TWO_FACTOR_SECRET))
  await page.getByTestId('totp-submit').click()

  await expect(page).toHaveURL(/\/dashboard$/)
  await expect(page.getByTestId('user-email')).toHaveText(TWO_FACTOR_USER)
})

test('registers a passkey under step-up, then logs in with it passwordlessly', async ({ page, context }) => {
  // A CDP virtual authenticator makes navigator.credentials.{create,get} real: a
  // discoverable (resident) credential with UV, so passwordless login works.
  const cdp = await context.newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  })

  // Log in with a password, then register a passkey (gated by step-up confirmation).
  await login(page, USER)
  await expect(page).toHaveURL(/\/dashboard$/)
  await page.getByTestId('confirm-password').fill(PASSWORD)
  await page.getByTestId('register-passkey').click()
  await expect(page.getByTestId('passkey-registered')).toBeVisible()

  // Log out, then sign in with only the passkey — no password.
  await page.getByTestId('logout').click()
  await expect(page).toHaveURL(/\/login$/)
  await page.getByTestId('passkey-login').click()

  await expect(page).toHaveURL(/\/dashboard$/)
  await expect(page.getByTestId('user-email')).toHaveText(USER)
})

test('verifies an email end-to-end via the signed link', async ({ page }) => {
  // NOTE: this permanently verifies unverified@example.com. The runner (browser.sh)
  // reseeds the DB each invocation, so a normal run starts clean; a manual re-run of
  // `playwright test` against a still-running fixture would fail the 'false' assertion.
  // The unverified user can log in but shows unverified.
  await login(page, UNVERIFIED_USER)
  await expect(page).toHaveURL(/\/dashboard$/)
  await expect(page.getByTestId('user-verified')).toHaveText('false')

  // Resend, then fetch the signed link the API mailed (test-only fixture route).
  await page.getByTestId('resend-email').click()
  await expect(page.getByTestId('email-sent')).toBeVisible()
  const { url } = await (await page.request.get(`${API_ROOT}/conformance/last-verification-url`)).json() as { url: string | null }
  expect(url, 'a signed verification URL should have been mailed').toBeTruthy()

  // Click it (a real browser navigation): the API verifies and redirects to /verified.
  await page.goto(url!)
  await expect(page.getByTestId('verified-state')).toHaveText('verified')

  // And the dashboard now reflects the verified state on a fresh load.
  await visit(page, '/dashboard')
  await expect(page.getByTestId('user-verified')).toHaveText('true')
})

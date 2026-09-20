import { totp } from '../../../../packages/core/conformance/authenticator'
import { expect, test } from '@playwright/test'

// Direct mode (SPA or SSG, per E2E_APP_MODE), same-origin with the lukk API under the
// unifying proxy. Client-rendered: the access token lives in memory and refresh rides
// the __Host- cookie — so these assert the direct transport works in a real browser.
const USER = 'user@example.com'
const TWO_FACTOR_USER = '2fa@example.com'
const TWO_FACTOR_SECRET = 'JBSWY3DPEHPK3PXP'
const PASSWORD = 'password'
type Page = import('@playwright/test').Page

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
  await visit(page, '/dashboard')
  await expect(page).toHaveURL(/\/login$/)
  await expect(page.getByTestId('email')).toBeVisible()
})

test('password login establishes a session and loads the user', async ({ page }) => {
  await login(page, USER)
  await expect(page).toHaveURL(/\/dashboard$/)
  await expect(page.getByTestId('user-email')).toHaveText(USER)
})

test('the session is restored on a full reload via the refresh cookie', async ({ page }) => {
  await login(page, USER)
  await expect(page).toHaveURL(/\/dashboard$/)
  // Full reload: memory is cleared, so re-auth must come from the __Host- refresh cookie.
  await visit(page, '/')
  await expect(page.getByTestId('auth-state')).toHaveText('authenticated')
  await expect(page.getByTestId('user-email')).toHaveText(USER)
})

test('logout clears the session and re-locks protected pages', async ({ page }) => {
  await login(page, USER)
  await expect(page).toHaveURL(/\/dashboard$/)
  await page.getByTestId('logout').click()
  await expect(page).toHaveURL(/\/login$/)
  await visit(page, '/dashboard')
  await expect(page).toHaveURL(/\/login$/)
})

test('a 2FA user is challenged, then completes login with a TOTP code', async ({ page }) => {
  await login(page, TWO_FACTOR_USER)
  await expect(page.getByTestId('two-factor-prompt')).toBeVisible()
  await page.getByTestId('totp-code').fill(totp(TWO_FACTOR_SECRET))
  await page.getByTestId('totp-submit').click()
  await expect(page).toHaveURL(/\/dashboard$/)
  await expect(page.getByTestId('user-email')).toHaveText(TWO_FACTOR_USER)
})

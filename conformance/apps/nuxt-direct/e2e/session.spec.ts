import { expect, test } from '@playwright/test'

/**
 * Direct mode's half of the logout-around-a-navigation story (the BFF's is in the other app).
 *
 * There is no server here to finish the logout, so the note the page leaves names the session it was
 * for — the access token's family — and the next page load ends only THAT one. What the specs check is
 * the consequence: the session really goes, and a sign-in that happened since does not.
 */
const PASSWORD = 'password'
// Everything shares one https origin under the unifying proxy, the API included.
const API_ROOT = process.env.LUKK_API_ROOT ?? 'https://localhost:8443'
const AWAY = `${API_ROOT}/up`

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
  await expect(page).toHaveURL(/\/dashboard$/)
}

async function freshUser(page: Page): Promise<{ email: string, password: string }> {
  const answer = await page.request.get(`${API_ROOT}/conformance/ephemeral-user`)
  return answer.json() as Promise<{ email: string, password: string }>
}

async function liveSessions(page: Page, email: string): Promise<number> {
  const answer = await page.request.get(`${API_ROOT}/conformance/live-sessions?email=${encodeURIComponent(email)}`)
  return (await answer.json() as { live: number }).live
}

test('a logout the page never awaited still ends the session', async ({ page }) => {
  const user = await freshUser(page)
  await login(page, user.email, user.password)

  await page.getByTestId('logout-navigate').click()
  await expect(page.getByTestId('auth-state')).toHaveText('guest')

  await expect.poll(() => liveSessions(page, user.email), { timeout: 15_000 }).toBe(0)
  await page.reload()
  await expect(page.getByTestId('auth-state')).toHaveText('guest')
})

test('the next page ends only the session that logout was for — not one signed in since', async ({ page, context }) => {
  const a = await freshUser(page)
  const b = await freshUser(page)
  await login(page, a.email, a.password)

  // Away to another origin, so this tab's note outlives the page without finishing there.
  await visit(page, `/dashboard?away=${encodeURIComponent(AWAY)}`)
  await page.getByTestId('logout-leave').click()
  await page.waitForURL(AWAY)

  // Someone signs in on this browser while that tab is away, and the tab comes back.
  const other = await context.newPage()
  await login(other, b.email, b.password)
  await visit(page, '/')

  // Still signed in as B — not "exactly one session": two tabs refreshing the same cookie can land
  // inside lukk's rotation grace window, which legitimately mints a sibling rather than revoking.
  expect(await liveSessions(page, b.email)).toBeGreaterThan(0)
  expect(await liveSessions(page, a.email)).toBe(0)
  await expect(page.getByTestId('user-email')).toHaveText(b.email)
})

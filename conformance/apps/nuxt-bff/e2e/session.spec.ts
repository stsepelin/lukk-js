import { expect, test } from '@playwright/test'
import { holdResponses, lukk } from './faults.mjs'

/**
 * What happens to a session around a logout the page never awaited — the case that keeps coming back:
 * a visitor clicks "log out" and the app navigates at once, so the logout is still in flight while the
 * next page is being served, and another tab may sign in meanwhile.
 *
 * These assert against the real lukk API (how many sessions are still usable) and against the raw
 * SERVER html, not just what the client eventually settles on. See conformance/browser.sh.
 */
const PASSWORD = 'password'
const API_ROOT = process.env.LUKK_API_ROOT ?? 'http://127.0.0.1:8000'
// Another origin entirely, to leave for and come back from (the API's health page).
const AWAY = `${API_ROOT}/up`

type Page = import('@playwright/test').Page
type Context = import('@playwright/test').BrowserContext

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

/** A fresh account, so one spec's logout can't decide another's user is signed out. */
async function freshUser(page: Page): Promise<{ email: string, password: string }> {
  const answer = await page.request.get(`${API_ROOT}/conformance/ephemeral-user`)
  return answer.json() as Promise<{ email: string, password: string }>
}

/** How many sessions lukk still considers usable for this account. */
async function liveSessions(page: Page, email: string): Promise<number> {
  const answer = await page.request.get(`${API_ROOT}/conformance/live-sessions?email=${encodeURIComponent(email)}`)
  return (await answer.json() as { live: number }).live
}

test.afterEach(() => { holdResponses(null); lukk('ok') })

test('a logout the page never awaited still ends the session, and the next page is signed out in the SERVER html', async ({ page }) => {
  const user = await freshUser(page)
  await login(page, user.email, user.password)

  // Waited for BEFORE the click: the navigation starts at once, and a waiter registered after it
  // would be listening for a response that has already come and gone.
  const landing = page.waitForResponse(r => r.request().isNavigationRequest() && new URL(r.url()).pathname === '/')
  await page.getByTestId('logout-navigate').click()

  // The html itself, before any client code ran: this is what a visitor sees on the first paint.
  expect(await (await landing).text()).toContain('data-testid="auth-state">guest')
  await expect(page.getByTestId('auth-state')).toHaveText('guest')
  expect(await liveSessions(page, user.email)).toBe(0)

  await page.reload()
  await expect(page.getByTestId('auth-state')).toHaveText('guest')
})

test('the visitor\'s other tabs follow that logout', async ({ page, context }) => {
  const user = await freshUser(page)
  await login(page, user.email, user.password)
  const other = await context.newPage()
  await visit(other, '/')
  await expect(other.getByTestId('auth-state')).toHaveText('authenticated')

  await page.getByTestId('logout-navigate').click()

  await expect(other.getByTestId('auth-state')).toHaveText('guest', { timeout: 10_000 })
})

test('a sign-in in another tab survives the logout of the session it replaced', async ({ page, context }) => {
  const a = await freshUser(page)
  const b = await freshUser(page)
  await login(page, a.email, a.password)
  const other = await context.newPage()

  // A leaves on a page whose SERVER render takes seconds — B signs in while it is still being produced.
  await page.getByTestId('logout-slow').click()
  await login(other, b.email, b.password)
  await page.waitForURL(/\/slow/)

  expect(await liveSessions(page, a.email)).toBe(0)
  expect(await liveSessions(page, b.email)).toBe(1)
  // And the cookie the browser holds is B's: a reload anywhere is B, not signed out.
  await other.reload()
  await expect(other.getByTestId('user-email')).toHaveText(b.email)
})

test('a logout left unfinished while lukk was unreachable does not end a session signed in since', async ({ page, context }) => {
  const a = await freshUser(page)
  const b = await freshUser(page)
  await login(page, a.email, a.password)

  // The logout request never reaches lukk, so A's session is still live and the note stands.
  lukk('fail-logout')
  await visit(page, `/dashboard?away=${encodeURIComponent(AWAY)}`)
  await page.getByTestId('logout-leave').click()
  await page.waitForURL(AWAY)
  lukk('ok')

  // Someone signs in on this browser while that tab is away, and the tab comes back.
  const other = await context.newPage()
  await login(other, b.email, b.password)
  await visit(page, '/')

  expect(await liveSessions(page, b.email)).toBe(1)
  await expect(page.getByTestId('user-email')).toHaveText(b.email)
  await expect(await freshTab(context)).toHaveText(b.email)
})

test('lukk being unreachable does not hold up the page, and the logout lands once it is back', async ({ page }) => {
  const user = await freshUser(page)
  await login(page, user.email, user.password)

  lukk('refuse')
  const started = Date.now()
  await page.getByTestId('logout-navigate').click()
  await expect(page.getByTestId('auth-state')).toHaveText('guest')
  expect(Date.now() - started).toBeLessThan(10_000)
  expect(await liveSessions(page, user.email)).toBe(1) // lukk was never told

  lukk('ok')
  await page.reload()
  await expect.poll(() => liveSessions(page, user.email), { timeout: 15_000 }).toBe(0)
  await expect(page.getByTestId('auth-state')).toHaveText('guest')
})

/** A brand-new tab in the same browser — the plainest reading of "what is this browser signed in as". */
async function freshTab(context: Context) {
  const tab = await context.newPage()
  await visit(tab, '/')
  return tab.getByTestId('user-email')
}

test('a sign-in in another tab survives a landing response held in flight after the server finished it', async ({ page, context }) => {
  // The gap a CDN, a proxy or a slow client opens: the response is complete, its cookies have not landed.
  const a = await freshUser(page)
  const b = await freshUser(page)
  await login(page, a.email, a.password)
  const other = await context.newPage()

  holdResponses('/', 4_000)
  await page.getByTestId('logout-navigate').click()
  await login(other, b.email, b.password)
  await page.waitForURL(/\/$/, { timeout: 15_000 })
  holdResponses(null)

  expect(await liveSessions(page, a.email)).toBe(0)
  expect(await liveSessions(page, b.email)).toBe(1)
  await other.reload()
  await expect(other.getByTestId('user-email')).toHaveText(b.email)
})

test('a server-side redirect carries the logout too, and keeps a sign-in that raced it', async ({ page, context }) => {
  const a = await freshUser(page)
  const b = await freshUser(page)
  await login(page, a.email, a.password)
  const other = await context.newPage()

  holdResponses('/redir', 4_000)
  await visit(page, `/dashboard?away=${encodeURIComponent('/redir')}`)
  await page.getByTestId('logout-leave').click()
  await login(other, b.email, b.password)
  await page.waitForURL(/\/login$/, { timeout: 15_000 }) // the redirect ran: signed out server-side
  holdResponses(null)

  expect(await liveSessions(page, a.email)).toBe(0)
  expect(await liveSessions(page, b.email)).toBe(1)
})

test('a page a route rule caches never hands one visitor\'s logout to the next', async ({ page, context }) => {
  const user = await freshUser(page)

  // A forged note + session on a cache MISS: whatever this response says must not be stored and replayed.
  const forged = await page.request.get('/cached?v=forged', {
    headers: { cookie: '__Host-lukk-logout=1; __Host-lukk-session=not-a-real-seal' },
  })
  expect(forged.headers()['vary']).toContain('cookie')
  expect(forged.headers()['set-cookie'] ?? '').not.toContain('lukk-signed-out')

  // A signed-in visitor asking for the same page stays signed in.
  await login(page, user.email, user.password)
  const reader = await context.newPage()
  await visit(reader, '/cached?v=forged')
  await expect(reader.getByTestId('user-email')).toHaveText(user.email)
  // Still signed in — not "exactly one session": two tabs refreshing one cookie can land inside lukk's
  // rotation grace window, which mints a sibling rather than revoking.
  expect(await liveSessions(page, user.email)).toBeGreaterThan(0)
})

test('a hanging lukk neither holds up the page nor loses the logout', async ({ page }) => {
  const user = await freshUser(page)
  await login(page, user.email, user.password)

  lukk('hang')
  const started = Date.now()
  await page.getByTestId('logout-navigate').click()
  await expect(page.getByTestId('auth-state')).toHaveText('guest', { timeout: 20_000 })
  const shown = Date.now() - started
  expect(shown).toBeLessThan(20_000) // the server gives up on lukk rather than holding the page open

  lukk('ok')
  await page.reload()
  await expect.poll(() => liveSessions(page, user.email), { timeout: 30_000 }).toBe(0)
})

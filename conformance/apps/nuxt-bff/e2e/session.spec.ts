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

test('the other tabs follow that logout even when the BFF answers before lukk does', async ({ page, context }) => {
  // The BFF answers a logout without waiting for lukk, so the announcement can reach the other tab
  // while the session is still being ended: that tab's check comes back with the account on its way
  // out, and the tab went on showing an account nobody is signed in to. Only ever seen where the
  // round trip is slow — CI, not a laptop — so the latency here is deliberate rather than incidental.
  const user = await freshUser(page)
  await login(page, user.email, user.password)
  const other = await context.newPage()
  await visit(other, '/')
  await expect(other.getByTestId('auth-state')).toHaveText('authenticated')

  lukk('ok', 800)
  await page.getByTestId('logout-navigate').click()

  await expect(other.getByTestId('auth-state')).toHaveText('guest', { timeout: 10_000 })
})

test('a tab that was away when the server finished the logout still hears about it', async ({ page, context }) => {
  // The other half of "other tabs follow": not the announcing tab's own logout, but a tab whose page
  // load is the one that finished it — it reads the server's signed-out answer and tells the rest.
  const user = await freshUser(page)
  await login(page, user.email, user.password)
  const other = await context.newPage()
  await visit(other, '/')
  await expect(other.getByTestId('auth-state')).toHaveText('authenticated')

  // The logout leaves a note but never reaches lukk from this page…
  lukk('fail-logout')
  await visit(page, `/dashboard?away=${encodeURIComponent(AWAY)}`)
  await page.getByTestId('logout-leave').click()
  await page.waitForURL(AWAY)
  // The fault really took: a note is standing and the session is still live. Without this the test
  // passes just as well when `fail-logout` does nothing, and then it proves only the ordinary path.
  expect((await context.cookies()).some(c => c.name === '__Host-lukk-logout')).toBe(true)
  expect(await liveSessions(page, user.email)).toBe(1)
  lukk('ok')

  // …so the next page load is what ends it, and that page is what the other tab hears from.
  await visit(page, '/')
  await expect(other.getByTestId('auth-state')).toHaveText('guest', { timeout: 10_000 })
  expect(await liveSessions(page, user.email)).toBe(0)
})

test('a sign-in in another tab survives the logout of the session it replaced', async ({ page, context }) => {
  const a = await freshUser(page)
  const b = await freshUser(page)
  await login(page, a.email, a.password)
  const other = await context.newPage()

  // A leaves on a page whose SERVER render takes seconds — B signs in while it is still being produced.
  const landing = page.waitForResponse(r => r.request().isNavigationRequest() && new URL(r.url()).pathname === '/slow')
  await page.getByTestId('logout-slow').click()
  await login(other, b.email, b.password)
  await page.waitForURL(/\/slow/)
  // The server rendered it signed out — the assertion the whole mechanism exists for.
  expect(await (await landing).text()).toContain('data-testid="auth-state">guest')

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
  // The note really is standing, and A really is still live — otherwise the rest proves nothing. Its
  // value is the moment the logout was asked for, which the page that finishes it reads back.
  const noted = (await context.cookies()).find(c => c.name === '__Host-lukk-logout')
  const askedAt = Number(noted?.value)
  expect(askedAt).toBeGreaterThan(Date.now() - 60_000)
  expect(askedAt).toBeLessThanOrEqual(Date.now())
  expect(await liveSessions(page, a.email)).toBe(1)
  lukk('ok')

  // Someone signs in on this browser while that tab is away, and the tab comes back.
  const other = await context.newPage()
  await login(other, b.email, b.password)
  await visit(page, '/')

  expect(await liveSessions(page, b.email)).toBe(1)
  await expect(page.getByTestId('user-email')).toHaveText(b.email)
  await expect(await freshTab(context)).toHaveText(b.email)
  // And A's own session is ended — by the sign-in that replaced it, not left running.
  await expect.poll(() => liveSessions(page, a.email), { timeout: 15_000 }).toBe(0)
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
  // And the held redirect didn't tell B's tabs they are signed out.
  await other.reload()
  await expect(other.getByTestId('user-email')).toHaveText(b.email)
})

test('a page a route rule caches never hands one visitor\'s session to the next', async ({ page, browser }) => {
  // Nitro stores such a page by path and replays it, so nothing per-visitor may end up in it. What keeps
  // that true is that a cached handler is handed ONLY the headers its rule declares in `varies` — by
  // default not the cookie — so the render has no session to hydrate and no token to rotate. This pins the
  // property rather than the mechanism: a rule that varies on the cookie, or a future Nitro that passes it
  // through, must still never hand one visitor's page or session cookie to the next.
  const user = await freshUser(page)
  await login(page, user.email, user.password)
  const warm = page.waitForResponse(r => r.request().isNavigationRequest() && new URL(r.url()).pathname === '/cached')
  await visit(page, '/cached?v=warm')
  // Even for the signed-in visitor who warms it, the SERVER html is signed out — the surprising half for
  // anyone adding a cache rule to a page that shows the user. (The client restores after hydration, so the
  // rendered DOM does say authenticated; that is why this reads the response rather than the page.)
  expect(await (await warm).text()).toContain('data-testid="auth-state">guest')

  const stranger = await browser.newContext({ ignoreHTTPSErrors: true })
  const other = await stranger.newPage()
  const served = other.waitForResponse(r => r.request().isNavigationRequest() && new URL(r.url()).pathname === '/cached')
  await other.goto('/cached?v=warm')
  const replayed = await served

  const body = await replayed.text()
  // Positively the cached page first: every assertion below is a `not`, so a navigation that never
  // happened, or a 404, would satisfy all of them and prove nothing.
  expect(replayed.status()).toBe(200)
  expect(body).toContain('data-testid="auth-state"')
  expect(body).not.toContain(user.email)
  expect(String((await replayed.allHeaders())['set-cookie'] ?? '')).not.toContain('lukk')
  expect((await stranger.cookies()).map(c => c.name)).not.toContain('__Host-lukk-session')
  await stranger.close()

  // And the visitor who warmed it is still signed in — the page just didn't render them.
  expect(await liveSessions(page, user.email)).toBeGreaterThan(0)
})

test('a forged logout note cannot be stored on a cached page and replayed to others', async ({ page, context }) => {
  const user = await freshUser(page)

  const forged = await page.request.get('/cached?v=forged', {
    headers: { cookie: '__Host-lukk-logout=1; __Host-lukk-session=not-a-real-seal' },
  })
  expect(forged.headers()['vary']).toContain('cookie')
  expect(forged.headers()['set-cookie'] ?? '').not.toContain('lukk-signed-out')

  // A signed-in visitor asking for the same page keeps their session — whatever the cached copy renders.
  await login(page, user.email, user.password)
  const reader = await context.newPage()
  const served = reader.waitForResponse(r => r.request().isNavigationRequest() && new URL(r.url()).pathname === '/cached')
  await visit(reader, '/cached?v=forged')
  expect(String((await (await served).allHeaders())['set-cookie'] ?? '')).not.toContain('signed-out')
  await expect(reader.getByTestId('user-email')).toHaveText(user.email)
  expect(await liveSessions(page, user.email)).toBeGreaterThan(0)
})

test('a hanging lukk neither holds up the page nor loses the logout', async ({ page }) => {
  // Its own budget: a 25 s wait followed by a 30 s poll cannot fit the suite's 30 s default, so this
  // passed only because the first wait normally resolves in seconds — a genuine hang would have been
  // reported as a timeout on the test rather than on the thing it is watching.
  test.setTimeout(90_000)
  const user = await freshUser(page)
  await login(page, user.email, user.password)

  lukk('hang')
  const started = Date.now()
  await page.getByTestId('logout-navigate').click()
  await expect(page.getByTestId('auth-state')).toHaveText('guest', { timeout: 25_000 })
  // Comfortably past the server's own 5 s give-up, and low enough to fail if that grows.
  expect(Date.now() - started).toBeLessThan(12_000)
  // The hang really took: the page reads as signed out while lukk has NOT ended the session. Without
  // this, a `hang` that quietly passed through would satisfy everything below.
  expect(await liveSessions(page, user.email)).toBe(1)

  lukk('ok')
  await page.reload()
  await expect.poll(() => liveSessions(page, user.email), { timeout: 30_000 }).toBe(0)
})

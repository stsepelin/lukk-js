import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __test } from './mocks/imports'

vi.mock('h3', () => ({
  defineEventHandler: (fn: unknown) => fn,
  getCookie: (event: { cookies: Record<string, string> }, name: string) => event.cookies[name],
  getRequestHeader: (event: { headers: Record<string, string> }, name: string) => event.headers[name],
  deleteCookie: (event: { deleted: { name: string, options: unknown }[] }, name: string, options: unknown) => { event.deleted.push({ name, options }) },
  setCookie: (event: { cookiesSet: { name: string, value: string, options: unknown }[] }, name: string, value: string, options: unknown) => { event.cookiesSet.push({ name, value, options }) },
  appendResponseHeader: (event: { appended: [string, string][] }, name: string, value: string) => { event.appended.push([name, value]) },
  setResponseHeader: (event: { set: Record<string, string> }, name: string, value: string) => { event.set[name] = value },
  // A seal named `sid:<x>` unseals to that sid; anything else doesn't unseal.
  unsealSession: async (_event: unknown, _config: unknown, sealed: string) => {
    if (!sealed.startsWith('sid:')) throw new Error('bad seal')
    const sid = sealed.slice(4)
    // `refresh:`-prefixed ids model a session whose access token has already gone.
    return { id: 'h3-id', data: sid.startsWith('refresh:') ? { sid, refresh: 'r' } : { sid, access: 'tok', refresh: 'r' } }
  },
}))

// eslint-disable-next-line import/first
import handler, { FAILURE_LIMIT, FINISH_LOGOUT_TIMEOUT_MS, forgetLogoutFailures, logoutFailureCount, RETRY_AFTER_FAILURE_MS } from '../src/runtime/server/finish-logout'

type LocalFetch = (input: string, init: RequestInit) => Promise<Response>

function makeEvent(o: { path?: string, cookies?: Record<string, string>, fetch?: LocalFetch | null, waitUntil?: (p: Promise<unknown>) => void } = {}) {
  const cookies = o.cookies ?? { '__Host-lukk-logout': '1', '__Host-lukk-session': 'sid:S1' }
  return {
    path: o.path ?? '/dashboard',
    cookies,
    headers: { cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ') },
    set: {} as Record<string, string>,
    context: {} as { lukkEndedSession?: { key?: string, session: string, note: string } },
    deleted: [] as { name: string, options: unknown }[],
    cookiesSet: [] as { name: string, value: string, options: unknown }[],
    appended: [] as [string, string][],
    ...(o.fetch === null ? {} : { fetch: o.fetch ?? vi.fn<LocalFetch>(async () => cleared(204)) }),
    ...(o.waitUntil ? { waitUntil: o.waitUntil } : {}),
  }
}

const SESSION_CLEARED = '__Host-lukk-session=; Path=/; HttpOnly; Secure; SameSite=Strict'
const NOTE_CLEARED = '__Host-lukk-logout=; Max-Age=0; Path=/; Secure; SameSite=Strict'
const noteGone = { name: '__Host-lukk-logout', options: { path: '/', secure: true, sameSite: 'strict' } }
const signedOut = { name: '__Host-lukk-signed-out', value: '1', options: { path: '/', secure: true, sameSite: 'strict', maxAge: 10 } }

/** The proxy's answer to its `/logout`: over → it clears the session and the note; otherwise neither. */
function cleared(status: number, over = status < 300): Response {
  const headers = new Headers()
  if (over) {
    headers.append('set-cookie', SESSION_CLEARED)
    headers.append('set-cookie', NOTE_CLEARED)
  }
  return new Response(null, { status, headers })
}

const run = (event: ReturnType<typeof makeEvent>) => (handler as unknown as (e: unknown) => Promise<void>)(event)
const perUser = { 'cache-control': 'no-store', 'vary': 'cookie' }

beforeEach(() => {
  __test.runtimeConfig.lukk = { sessionPassword: 'p'.repeat(32) } as unknown as Record<string, unknown>
  forgetLogoutFailures()
})
afterEach(() => { __test.reset(); vi.useRealTimers() })

describe('finish-logout middleware (BFF)', () => {
  it('does nothing for a request without the logout note', async () => {
    const event = makeEvent({ cookies: { '__Host-lukk-session': 'sid:S1', '__Host-lukk-signed-out': '1' } })
    await run(event)
    expect(event.fetch).not.toHaveBeenCalled()
    expect(event.set).toEqual({})
    expect(event.deleted).toEqual([])
  })

  it('leaves the proxy\'s own calls alone — the browser finishing the logout, or signing in', async () => {
    const event = makeEvent({ path: '/api/_lukk/login' })
    await run(event)
    expect(event.fetch).not.toHaveBeenCalled()
    expect(event.set).toEqual({})
  })

  it('drops a note with no session to end', async () => {
    const event = makeEvent({ cookies: { '__Host-lukk-logout': '1' } })
    await run(event)
    expect(event.fetch).not.toHaveBeenCalled()
    expect(event.deleted).toEqual([{ name: '__Host-lukk-logout', options: { path: '/', secure: true, sameSite: 'strict' } }])
  })

  it('ends the session through the proxy\'s /logout before the page renders, drops the note, and answers that the browser is signed out', async () => {
    const event = makeEvent()
    await run(event)

    expect(event.fetch).toHaveBeenCalledOnce()
    const [url, init] = (event.fetch as ReturnType<typeof vi.fn>).mock.calls[0]! as [string, RequestInit]
    expect(url).toBe('/api/_lukk/logout')
    expect(init).toMatchObject({ method: 'POST', body: '{}' })
    // The page request's own navigation headers are blanked: a same-site navigation would fail the proxy's CSRF check.
    expect(init.headers).toEqual({
      'accept': 'application/json',
      'content-type': 'application/json',
      'content-length': '2',
      'cookie': '__Host-lukk-logout=1; __Host-lukk-session=sid:S1',
      'origin': '',
      'referer': '',
      'sec-fetch-site': '',
      'sec-fetch-mode': '',
      'sec-fetch-dest': '',
    })
    expect(event.set).toEqual(perUser)
    // NOT the cleared session cookie: this response is finalised long after, and a sign-in in another tab
    // meanwhile would have its newer cookie wiped by it. The browser's own logout response clears that one.
    expect(event.appended).toEqual([])
    expect(event.deleted).toEqual([noteGone])
    // In a cookie, for this browser — not in a payload a cached page could carry to everyone.
    expect(event.cookiesSet).toEqual([signedOut])
    // What the last check before the headers go out needs.
    expect(event.context.lukkEndedSession).toEqual({ key: 'S1', marker: '__Host-lukk-signed-out' })
  })

  it('drops a note that arrives with no session cookie at all', async () => {
    const event = makeEvent({ cookies: { '__Host-lukk-logout': '1' } })
    await run(event)
    expect(event.fetch).not.toHaveBeenCalled()
    expect(event.deleted).toEqual([noteGone])
  })

  it('ends a session that has only a refresh token left', async () => {
    const event = makeEvent({ cookies: { '__Host-lukk-logout': '1', '__Host-lukk-session': 'sid:refresh:S9' } })
    await run(event)
    expect(event.fetch).toHaveBeenCalledOnce()
    expect(event.cookiesSet).toEqual([signedOut])
  })

  it('does no work for a cookie that does not unseal — any string would otherwise buy a held page load', async () => {
    const event = makeEvent({ cookies: { '__Host-lukk-logout': '1', '__Host-lukk-session': 'TAMPERED' } })
    await run(event)
    expect(event.fetch).not.toHaveBeenCalled()
    expect(event.cookiesSet).toEqual([])
    expect(event.deleted).toEqual([noteGone]) // nothing to end: the note goes
    expect(event.context.lukkEndedSession).toBeUndefined()
  })

  it('carries a session the proxy RE-SEALED — it holds a refresh token this server already spent — and nothing else it picked up', async () => {
    const resealed = '__Host-lukk-session=RESEALED; Path=/; HttpOnly; Secure; SameSite=Strict'
    const event = makeEvent({ fetch: vi.fn<LocalFetch>(async () => {
      const res = cleared(204)
      res.headers.append('set-cookie', resealed)
      res.headers.append('set-cookie', 'csrf=abc; Path=/')
      res.headers.append('set-cookie', 'lukk-session-extra=1; Path=/')
      return res
    }) })
    await run(event)
    expect(event.appended).toEqual([['set-cookie', resealed]])
  })

  it.each([
    ['a throttle', 429],
    ['an outage', 503],
    ['a 401 the proxy could still renew past', 401],
  ])('keeps the note pending when the logout didn\'t end the session (%s) — the page is still per-user and signed out, and the browser finishes it', async (_, status) => {
    const event = makeEvent({ fetch: vi.fn<LocalFetch>(async () => cleared(status, false)) })
    await run(event)
    expect(event.set).toEqual(perUser)
    expect(event.appended).toEqual([])
    expect(event.cookiesSet).toEqual([])
    expect(event.deleted).toEqual([])
    expect(event.context.lukkEndedSession).toBeUndefined()
  })

  it('does not call it over on a renewal the proxy re-sealed before its logout failed — only the note\'s clearing says that', async () => {
    const resealed = '__Host-lukk-session=RESEALED; Path=/; HttpOnly; Secure; SameSite=Strict'
    const event = makeEvent({ fetch: vi.fn<LocalFetch>(async () => {
      const res = new Response(null, { status: 503 })
      res.headers.append('set-cookie', resealed)
      return res
    }) })
    await run(event)
    expect(event.appended).toEqual([['set-cookie', resealed]]) // the browser must get the rotated seal
    expect(event.cookiesSet).toEqual([])
    expect(event.deleted).toEqual([])
  })

  it('leaves it to the browser when the in-process call fails or isn\'t available', async () => {
    const failing = makeEvent({ fetch: vi.fn<LocalFetch>(async () => { throw new Error('boom') }) })
    await run(failing)
    expect(failing.set).toEqual(perUser)
    expect(failing.appended).toEqual([])

    const bare = makeEvent({ fetch: null, cookies: { '__Host-lukk-logout': '1', '__Host-lukk-session': 'sid:OTHER' } })
    await run(bare)
    expect(bare.set).toEqual(perUser)
    expect(bare.appended).toEqual([])
    expect(bare.cookiesSet).toEqual([])
  })

  it('does not hold the page past its timeout — the logout goes on in the background', async () => {
    vi.useFakeTimers()
    let answer!: (r: Response) => void
    const waitUntil = vi.fn()
    const event = makeEvent({ fetch: vi.fn<LocalFetch>(() => new Promise((resolve) => { answer = resolve })), waitUntil })

    const pending = run(event)
    await vi.advanceTimersByTimeAsync(FINISH_LOGOUT_TIMEOUT_MS)
    await pending

    expect(event.cookiesSet).toEqual([]) // the note stays pending
    expect(waitUntil).toHaveBeenCalledOnce()
    answer(cleared(204))
    await expect(waitUntil.mock.calls[0]![0]).resolves.toBeInstanceOf(Response)
  })

  it('sends one logout for the requests a page makes while the first is out, and a new one after', async () => {
    let answer!: (r: Response) => void
    const fetch = vi.fn<LocalFetch>(() => new Promise((resolve) => { answer = resolve }))
    const first = makeEvent({ fetch })
    const second = makeEvent({ fetch })

    const both = Promise.all([run(first), run(second)])
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled())
    answer(cleared(204))
    await both

    expect(fetch).toHaveBeenCalledOnce()
    expect(second.cookiesSet).toEqual([signedOut])

    fetch.mockImplementation(async () => cleared(204))
    await run(makeEvent({ fetch }))
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('leaves lukk alone for a while after a logout that didn\'t go through — a page load is many requests', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn<LocalFetch>(async () => cleared(503))
    await run(makeEvent({ fetch }))
    const next = makeEvent({ fetch })
    await run(next)
    expect(fetch).toHaveBeenCalledOnce()
    expect(next.set).toEqual(perUser) // still per-user, still signed out
    await run(makeEvent({ fetch, cookies: { '__Host-lukk-logout': '1', '__Host-lukk-session': 'sid:OTHER' } })) // another session isn't held back
    expect(fetch).toHaveBeenCalledTimes(2)

    vi.advanceTimersByTime(RETRY_AFTER_FAILURE_MS)
    fetch.mockImplementation(async () => cleared(204))
    await run(makeEvent({ fetch }))
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('keeps its memory of failures bounded, whatever the rate — expired ones first, then the oldest — and small per entry', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn<LocalFetch>(async () => cleared(503))
    const failFor = (sealed: string) => run(makeEvent({ fetch, cookies: { '__Host-lukk-logout': '1', '__Host-lukk-session': sealed } }))

    for (let i = 0; i < FAILURE_LIMIT; i++) await failFor(`sid:S${i}`)
    expect(logoutFailureCount()).toBe(FAILURE_LIMIT)

    // None expired: the oldest goes, and it is asked again at once.
    await failFor('sid:NEW')
    expect(logoutFailureCount()).toBe(FAILURE_LIMIT)
    fetch.mockClear()
    await failFor('sid:S0')
    expect(fetch).toHaveBeenCalledOnce()
    await failFor('sid:S2') // still held back
    expect(fetch).toHaveBeenCalledOnce()

    // All expired: they go first.
    vi.advanceTimersByTime(RETRY_AFTER_FAILURE_MS)
    await failFor('sid:LATER')
    expect(logoutFailureCount()).toBe(1)

    // A session that fails again counts as the newest, not the oldest.
    forgetLogoutFailures()
    await failFor('sid:AGAIN')
    vi.advanceTimersByTime(RETRY_AFTER_FAILURE_MS / 2)
    for (let i = 0; i < FAILURE_LIMIT - 2; i++) await failFor(`sid:B${i}`)
    vi.advanceTimersByTime(RETRY_AFTER_FAILURE_MS / 2)
    await failFor('sid:AGAIN') // expired, so asked again — and fails again, while the map isn't full
    await failFor('sid:C')
    await failFor('sid:NEWEST') // full, nothing expired: the oldest (B0) goes, not AGAIN
    fetch.mockClear()
    await failFor('sid:AGAIN')
    expect(fetch).not.toHaveBeenCalled()
    await failFor('sid:B0')
    expect(fetch).toHaveBeenCalledOnce()

    // Keyed by the session's own id: a re-sealed cookie for the same session does not start over.
    forgetLogoutFailures()
    await failFor('sid:SAME')
    fetch.mockClear()
    await run(makeEvent({ fetch, cookies: { '__Host-lukk-logout': '1', '__Host-lukk-session': 'sid:SAME' } }))
    expect(fetch).not.toHaveBeenCalled()
  })

  it('reads the note and session under the app\'s own names — relaxed and namespaced', async () => {
    Object.assign(__test.runtimeConfig.lukk, { cookieSecure: false, cookieNamespace: 'admin' })
    const other = makeEvent() // another app's default-named cookies
    await run(other)
    expect(other.fetch).not.toHaveBeenCalled()

    const own = makeEvent({ cookies: { 'lukk-admin-logout': '1', 'lukk-admin-session': 'sid:S1' }, fetch: vi.fn<LocalFetch>(async () => {
      const res = new Response(null, { status: 204 })
      res.headers.append('set-cookie', '__Host-lukk-session=; Max-Age=0') // another app's name: not forwarded
      res.headers.append('set-cookie', 'lukk-admin-session=; Max-Age=0')
      res.headers.append('set-cookie', 'lukk-admin-logout=; Max-Age=0')
      return res
    }) })
    await run(own)
    expect(own.fetch).toHaveBeenCalledOnce()
    expect(own.appended).toEqual([]) // only clears among them
    expect(own.deleted).toEqual([{ name: 'lukk-admin-logout', options: { path: '/', secure: false, sameSite: 'strict' } }])
    expect(own.cookiesSet).toEqual([{ name: 'lukk-admin-signed-out', value: '1', options: { path: '/', secure: false, sameSite: 'strict', maxAge: 10 } }])

    const bare = makeEvent({ cookies: { 'lukk-admin-logout': '1' } })
    await run(bare)
    expect(bare.deleted).toEqual([{ name: 'lukk-admin-logout', options: { path: '/', secure: false, sameSite: 'strict' } }])
  })
})

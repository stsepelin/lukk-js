import type { IncomingMessage, Server } from 'node:http'
import { createServer } from 'node:http'
import { createApp, defineEventHandler, toNodeListener, unsealSession, useSession } from 'h3'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
// REAL h3 and BOTH real handlers — the auth proxy and the app-API proxy — over real sockets, against a
// throwaway lukk and app API, with a cookie jar standing in for the browser: the browser keeps whichever
// `Set-Cookie` arrives LAST, and that is the whole of the bug pinned here.
import { __test } from './mocks/imports'
import bff from '../src/runtime/server/bff'
import apiProxy from '../src/runtime/server/api-proxy'
import { forgetRefreshJournal, refreshHeads, confirmationsHeld } from '../src/runtime/server/refresh-journal'
import { CONFIRMATIONS_HELD_LIMIT, deliverPair, dropConfirmation, holdConfirmation } from '../src/runtime/server/refresh'
import { LUKK_BFF_PREFIX } from '../src/runtime/shared'

const SESSION_PASSWORD = 'p'.repeat(32)
const COOKIE = 'lukk-session' // `cookieSecure: false`
const port = (s: Server) => (s.address() as { port: number }).port
const now = () => Math.floor(Date.now() / 1000)
let seq = 0
const jwt = (exp: number) => {
  const seg = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${seg({ alg: 'HS256' })}.${seg({ exp, n: ++seq })}.sig`
}

interface Gate { promise: Promise<void>, open: () => void }
function gate(): Gate {
  let open!: () => void
  const promise = new Promise<void>((resolve) => { open = resolve })
  return { promise, open }
}

/** lukk, as far as these flows reach it: rotation with reuse refusal, step-up, a gated route, logout. */
const lukkState = {
  spent: new Set<string>(),
  live: new Set<string>(),
  confirmations: new Set<string>(),
  confirmTtl: 300,
  /** Holds lukk's answer to `/slow` until opened. */
  slow: gate(),
  slowArrived: gate(),
}
/** The app API: `/poll` is held until opened. */
const pollGates = new Map<string, { arrived: Gate, release: Gate }>()

let lukk: Server
let upstream: Server
let app: Server
let appURL = ''

const body = (req: IncomingMessage) => new Promise<string>((resolve) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c as Buffer))
  req.on('end', () => resolve(Buffer.concat(chunks).toString()))
})

beforeAll(async () => {
  lukk = createServer(async (req, res) => {
    const text = await body(req)
    const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '')
    const json = (status: number, data: unknown) => {
      res.statusCode = status
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(data))
    }
    if (req.url === '/auth/refresh') {
      const { refresh_token: token } = JSON.parse(text) as { refresh_token: string }
      // A replay is refused, as lukk's reuse detection would.
      if (lukkState.spent.has(token)) return json(401, { message: 'Unauthenticated.' })
      lukkState.spent.add(token)
      const access = jwt(now() + 900)
      lukkState.live.add(access)
      return json(200, { access_token: access, refresh_token: `${token}'`, expires_in: 900 })
    }
    if (!lukkState.live.has(bearer)) return json(401, { message: 'Unauthenticated.' })
    if (req.url === '/auth/confirm-password') {
      const confirmation = jwt(now() + lukkState.confirmTtl)
      lukkState.confirmations.add(confirmation)
      return json(200, { confirmation_token: confirmation })
    }
    if (req.url === '/auth/gated') {
      if (!lukkState.confirmations.has(String(req.headers['x-lukk-confirmation']))) return json(423, { message: 'This action requires confirmation.' })
      return json(200, { gated: true })
    }
    if (req.url === '/auth/slow') {
      lukkState.slowArrived.open()
      await lukkState.slow.promise
      return json(200, { slow: true })
    }
    if (req.url === '/auth/logout') {
      lukkState.live.delete(bearer)
      return json(200, { status: 'logged-out' })
    }
    json(404, {})
  })
  await new Promise<void>(r => lukk.listen(0, '127.0.0.1', r))

  upstream = createServer(async (req, res) => {
    const gates = pollGates.get(String(req.headers['x-test-poll']))
    gates?.arrived.open()
    await gates?.release.promise
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ polled: true }))
  })
  await new Promise<void>(r => upstream.listen(0, '127.0.0.1', r))

  __test.runtimeConfig.lukk = {
    apiPath: '/api',
    apiTarget: `http://127.0.0.1:${port(upstream)}`,
    apiForceJson: true,
    baseURL: `http://127.0.0.1:${port(lukk)}/auth`,
    sessionPassword: SESSION_PASSWORD,
    cookieSecure: false,
  } as unknown as Record<string, unknown>

  const h3 = createApp()
  // A signed-in browser whose access token has expired: the next request through either proxy renews it.
  h3.use('/__mint', defineEventHandler(async (event) => {
    const sid = new URL(event.path, 'http://x').searchParams.get('sid')!
    const s = await useSession(event, { password: SESSION_PASSWORD, name: COOKIE, cookie: { sameSite: 'strict', secure: false, httpOnly: true, path: '/' } })
    await s.update({ access: jwt(now() - 10), refresh: `rt-${sid}`, sid })
    return { ok: true }
  }))
  // As Nuxt mounts them: the auth proxy under its prefix, the app-API proxy for the rest of `/api`.
  h3.use(defineEventHandler(event => (event.path.startsWith(LUKK_BFF_PREFIX) ? bff(event) : apiProxy(event))))
  app = createServer(toNodeListener(h3))
  await new Promise<void>(r => app.listen(0, '127.0.0.1', r))
  appURL = `http://127.0.0.1:${port(app)}`
})

afterAll(() => { lukk?.close(); upstream?.close(); app?.close() })

afterEach(() => {
  lukkState.confirmTtl = 300
  lukkState.slow = gate()
  lukkState.slowArrived = gate()
  vi.restoreAllMocks()
})

/** The browser: one session cookie, replaced by whichever response carrying one arrives last. */
class Browser {
  cookie = ''

  static async signedIn(sid: string): Promise<Browser> {
    const browser = new Browser()
    browser.take((await fetch(`${appURL}/__mint?sid=${sid}`)).headers.getSetCookie())
    return browser
  }

  /** Send now with the cookie held now; the response's cookie is taken when it is applied. */
  async send(method: string, path: string, headers: Record<string, string> = {}): Promise<{ status: number, body: string, setCookie: string[], apply: () => void }> {
    const res = await fetch(`${appURL}${path}`, { method, headers: { cookie: `${COOKIE}=${this.cookie}`, ...headers } })
    const body = await res.text()
    const setCookie = res.headers.getSetCookie()
    return { status: res.status, body, setCookie, apply: () => this.take(setCookie) }
  }

  async request(method: string, path: string): Promise<number> {
    const res = await this.send(method, path)
    res.apply()
    return res.status
  }

  take(setCookie: string[]): void {
    const ours = setCookie.find(c => c.startsWith(`${COOKIE}=`))
    if (ours) this.cookie = ours.split(';')[0]!.slice(COOKIE.length + 1)
  }
}

/** What a session cookie a response carries holds. */
async function sealed(setCookie: string[]): Promise<{ refresh?: string, confirmation?: string } | undefined> {
  const ours = setCookie.find(c => c.startsWith(`${COOKIE}=`))
  if (!ours) return undefined
  const seal = decodeURIComponent(ours.split(';')[0]!.slice(COOKIE.length + 1))
  return (await unsealSession({} as never, { password: SESSION_PASSWORD }, seal)).data as { refresh?: string, confirmation?: string }
}

/** An app-API long-poll, sent with the browser's cookie as it stands, held at the API until released. */
async function longPoll(browser: Browser, name: string): Promise<{ release: () => Promise<{ status: number, body: string, setCookie: string[], apply: () => void }> }> {
  const gates = { arrived: gate(), release: gate() }
  pollGates.set(name, gates)
  const out = browser.send('GET', '/api/poll', { 'x-test-poll': name })
  // At the API: its proactive refresh has rotated the session and re-sealed the cookie it will carry.
  await gates.arrived.promise
  return { release: async () => { gates.release.open(); return out } }
}

describe('a step-up confirmation and a slower response from the same session (BFF)', () => {
  it('survives an app-API long-poll that re-sealed the session before it and lands after it', async () => {
    const sid = `poll-${Math.random()}`
    const browser = await Browser.signedIn(sid)
    const poll = await longPoll(browser, 'repro')

    // Confirmed while the long-poll is out: the cookie now carries the confirmation.
    expect(await browser.request('POST', `${LUKK_BFF_PREFIX}/confirm-password`)).toBe(200)

    // The long-poll lands last, with the pair it sealed — and must not take the confirmation with it.
    const late = await poll.release()
    late.apply()
    expect(late.status).toBe(200)

    expect(await browser.request('GET', `${LUKK_BFF_PREFIX}/gated`)).toBe(200)
    // Honoured, so still held: only lukk's refusal lets it go.
    expect(confirmationsHeld.has(sid)).toBe(true)
  })

  it('leaves a renewal that already holds the confirmation as it is — its lifetime still reported', async () => {
    const sid = `refresh-${Math.random()}`
    const browser = await Browser.signedIn(sid)
    expect(await browser.request('POST', `${LUKK_BFF_PREFIX}/confirm-password`)).toBe(200)

    const renewed = await browser.send('POST', `${LUKK_BFF_PREFIX}/refresh`)
    expect(renewed.status).toBe(200)
    expect(JSON.parse(renewed.body)).toEqual({ ok: true, expires_in: expect.any(Number) })
    renewed.apply()
    expect(await browser.request('GET', `${LUKK_BFF_PREFIX}/gated`)).toBe(200)
  })

  it('takes no confirmation away from a cookie when none is held', async () => {
    const sid = `unheld-${Math.random()}`
    const browser = await Browser.signedIn(sid)
    expect(await browser.request('POST', `${LUKK_BFF_PREFIX}/confirm-password`)).toBe(200)
    // Not held here (another process sealed it, or the bound was reached): the cookie's own is kept.
    forgetRefreshJournal(sid)

    const renewed = await browser.send('POST', `${LUKK_BFF_PREFIX}/refresh`)
    expect(JSON.parse(renewed.body)).toEqual({ ok: true, expires_in: expect.any(Number) })
    renewed.apply()
    expect(await browser.request('GET', `${LUKK_BFF_PREFIX}/gated`)).toBe(200)
  })

  it('carries nothing onto a pair the session has moved past — the cookie is still withheld', () => {
    const sid = `stale-${Math.random()}`
    refreshHeads.set(sid, { token: 'newer', timer: setTimeout(() => {}, 0) })
    holdConfirmation(sid, jwt(now() + 60))
    try {
      expect(deliverPair({ node: { req: {}, res: {} } } as never, sid, { access: 'a', refresh: 'older' }, undefined)).toBeNull()
    }
    finally { forgetRefreshJournal(sid) }
  })

  it('survives the auth proxy\'s own 401 renewal sealed before it and landing after it', async () => {
    const browser = await Browser.signedIn(`retry-${Math.random()}`)
    // Expired token → 401 → renewal → the retried call is slow at lukk; the renewal's cookie leaves after it.
    const slow = browser.send('GET', `${LUKK_BFF_PREFIX}/slow`)
    await lukkState.slowArrived.promise

    expect(await browser.request('POST', `${LUKK_BFF_PREFIX}/confirm-password`)).toBe(200)

    lukkState.slow.open()
    const late = await slow
    late.apply()
    expect(late.status).toBe(200)

    expect(await browser.request('GET', `${LUKK_BFF_PREFIX}/gated`)).toBe(200)
  })

  it('carries nothing into a different session', async () => {
    const one = await Browser.signedIn(`one-${Math.random()}`)
    const two = await Browser.signedIn(`two-${Math.random()}`)
    const pollOne = await longPoll(one, 'one')
    const pollTwo = await longPoll(two, 'two')

    expect(await one.request('POST', `${LUKK_BFF_PREFIX}/confirm-password`)).toBe(200)

    expect((await sealed((await pollTwo.release()).setCookie))?.confirmation).toBeUndefined()
    expect((await sealed((await pollOne.release()).setCookie))?.confirmation).toEqual(expect.any(String))
  })

  it('resurrects nothing after a logout — the record goes with the session', async () => {
    const sid = `logout-${Math.random()}`
    const browser = await Browser.signedIn(sid)
    const poll = await longPoll(browser, 'logout')
    expect(await browser.request('POST', `${LUKK_BFF_PREFIX}/confirm-password`)).toBe(200)
    expect(confirmationsHeld.has(sid)).toBe(true)

    expect(await browser.request('POST', `${LUKK_BFF_PREFIX}/logout`)).toBe(200)
    expect(confirmationsHeld.has(sid)).toBe(false)

    // The long-poll's cookie is withheld outright: the session it carries has ended.
    expect(await sealed((await poll.release()).setCookie)).toBeUndefined()
  })

  it('carries no confirmation lukk has since refused (423)', async () => {
    const sid = `refused-${Math.random()}`
    const browser = await Browser.signedIn(sid)
    const poll = await longPoll(browser, 'refused')
    expect(await browser.request('POST', `${LUKK_BFF_PREFIX}/confirm-password`)).toBe(200)

    // lukk no longer honours it: the gated call answers 423, the client asks the user to confirm again.
    lukkState.confirmations.clear()
    expect(await browser.request('GET', `${LUKK_BFF_PREFIX}/gated`)).toBe(423)
    expect(confirmationsHeld.has(sid)).toBe(false)

    expect((await sealed((await poll.release()).setCookie))?.confirmation).toBeUndefined()
  })

  it('records nothing for a step-up answered "confirm again" (409)', async () => {
    const sid = `moved-${Math.random()}`
    const browser = await Browser.signedIn(sid)
    // Renewed through the auth proxy, so the browser holds a live pair.
    lukkState.slow.open()
    expect(await browser.request('GET', `${LUKK_BFF_PREFIX}/slow`)).toBe(200)
    // …which the session has since moved past, the links that led on gone.
    forgetRefreshJournal(sid)
    refreshHeads.set(sid, { token: 'elsewhere', timer: setTimeout(() => {}, 0) })

    expect(await browser.request('POST', `${LUKK_BFF_PREFIX}/confirm-password`)).toBe(409)
    expect(confirmationsHeld.has(sid)).toBe(false)
    forgetRefreshJournal(sid)
  })

  it('drops a confirmation once it has expired', async () => {
    const sid = `expired-${Math.random()}`
    const browser = await Browser.signedIn(sid)
    const poll = await longPoll(browser, 'expired')
    lukkState.confirmTtl = -1
    expect(await browser.request('POST', `${LUKK_BFF_PREFIX}/confirm-password`)).toBe(200)
    // Its own expiry has passed: the timer that ends it runs before the long-poll lands.
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(confirmationsHeld.has(sid)).toBe(false)

    expect((await sealed((await poll.release()).setCookie))?.confirmation).toBeUndefined()
  })
})

describe('holdConfirmation', () => {
  afterEach(() => vi.useRealTimers())

  it('holds a confirmation until its own expiry, and not a moment longer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    // On a whole second, as lukk's `exp` is.
    vi.setSystemTime(Math.ceil(Date.now() / 1000) * 1000)
    const sid = `ttl-${Math.random()}`
    holdConfirmation(sid, jwt(now() + 60))
    await vi.advanceTimersByTimeAsync(60_000 - 1)
    expect(confirmationsHeld.has(sid)).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(confirmationsHeld.has(sid)).toBe(false)
  })

  it('lets a newer confirmation replace the one held, on its own expiry', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const sid = `newer-${Math.random()}`
    holdConfirmation(sid, jwt(now() + 10))
    const newer = jwt(now() + 60)
    holdConfirmation(sid, newer)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(confirmationsHeld.get(sid)?.token).toBe(newer)
    forgetRefreshJournal(sid)
    expect(confirmationsHeld.has(sid)).toBe(false)
  })

  it('lets go only of the confirmation lukk refused — one held since stays', () => {
    const sid = `drop-${Math.random()}`
    const newer = jwt(now() + 60)
    holdConfirmation(sid, newer)
    dropConfirmation(sid, jwt(now() + 60))
    dropConfirmation(sid, undefined)
    dropConfirmation(`nothing-held-${Math.random()}`, undefined)
    expect(confirmationsHeld.get(sid)?.token).toBe(newer)
    dropConfirmation(sid, newer)
    expect(confirmationsHeld.has(sid)).toBe(false)
  })

  it('lets a refused confirmation\'s expiry leave one held after it alone', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const sid = `refused-then-newer-${Math.random()}`
    const refused = jwt(now() + 10)
    holdConfirmation(sid, refused)
    dropConfirmation(sid, refused)
    const newer = jwt(now() + 60)
    holdConfirmation(sid, newer)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(confirmationsHeld.get(sid)?.token).toBe(newer)
    forgetRefreshJournal(sid)
  })

  it('holds nothing it cannot read an expiry from', () => {
    holdConfirmation('opaque', 'not-a-jwt')
    holdConfirmation('no-exp', `${Buffer.from('{}').toString('base64url')}.${Buffer.from('{}').toString('base64url')}.sig`)
    expect(confirmationsHeld.has('opaque')).toBe(false)
    expect(confirmationsHeld.has('no-exp')).toBe(false)
  })

  it(`holds at most ${CONFIRMATIONS_HELD_LIMIT} sessions — past it a new one is not held (warned once), a held one still renews`, () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const timer = setTimeout(() => {}, 0)
    const filler = Array.from({ length: CONFIRMATIONS_HELD_LIMIT - 1 - confirmationsHeld.size }, (_, i) => `filler-${i}`)
    for (const id of filler) confirmationsHeld.set(id, { token: 't', timer })
    try {
      holdConfirmation('last-in', jwt(now() + 60))
      expect(confirmationsHeld.has('last-in')).toBe(true)

      holdConfirmation('over', jwt(now() + 60))
      holdConfirmation('over-again', jwt(now() + 60))
      holdConfirmation('over-thrice', jwt(now() + 60))
      expect(confirmationsHeld.has('over')).toBe(false)
      expect(confirmationsHeld.has('over-again')).toBe(false)
      expect(warn).toHaveBeenCalledOnce()
      expect(String(warn.mock.calls[0]![0])).toContain(`More than ${CONFIRMATIONS_HELD_LIMIT} sessions hold a step-up confirmation`)

      const renewed = jwt(now() + 60)
      holdConfirmation('last-in', renewed)
      expect(confirmationsHeld.get('last-in')?.token).toBe(renewed)
    }
    finally {
      for (const id of [...filler, 'last-in']) forgetRefreshJournal(id)
    }
  })
})

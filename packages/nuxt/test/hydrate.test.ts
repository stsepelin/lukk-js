import type { H3Event } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __test } from './mocks/imports'
import type { TokenSession } from '../src/runtime/server/utils/refresh'

// The sealed session the read-only unseal returns, and the read-write handle `useSession` opens.
let cookieValue: string | undefined // getCookie's return (present seal vs anonymous)
let unsealResult: { data?: TokenSession } | undefined
let unsealThrows: boolean
const sessionUpdate = vi.fn()
let sessionObj: { id?: string, data: TokenSession, update: typeof sessionUpdate }

let noteValue: string | undefined // the browser's logout note, when a test sets one
const getCookie = vi.fn((_event: unknown, name: string) => (/-logout$|-signed-out$/.test(name) ? noteValue : cookieValue))
const unsealSession = vi.fn(async () => { if (unsealThrows) throw new Error('bad seal'); return unsealResult })
const useSession = vi.fn(async () => sessionObj)
const sealSession = vi.fn(async () => 'FRESH_SEAL')
const setResponseHeader = vi.fn()

vi.mock('h3', () => ({
  getCookie: (...a: unknown[]) => getCookie(...a),
  unsealSession: (...a: unknown[]) => unsealSession(...a),
  useSession: (...a: unknown[]) => useSession(...a),
  sealSession: (...a: unknown[]) => sealSession(...a),
  setResponseHeader: (...a: unknown[]) => setResponseHeader(...a),
  getRequestHeader: (event: { headers?: Record<string, string> }, name: string) => event.headers?.[name],
}))

const refreshOnce = vi.fn<(s: unknown, b: string) => Promise<TokenSession | null>>()
vi.mock('../src/runtime/server/utils/refresh', () => ({ refreshOnce: (...a: unknown[]) => refreshOnce(...(a as [unknown, string])) }))
const revokeDroppedSession = vi.fn()
vi.mock('../src/runtime/server/revoke-dropped', () => ({ revokeDroppedSession: (...a: unknown[]) => revokeDroppedSession(...a) }))

// eslint-disable-next-line import/first
import { hydratedSessionEnded, resolveHydrationAccess, withholdIfReplaced } from '../src/runtime/server/hydrate'
// eslint-disable-next-line import/first
import { forgetEndedSessions, markSessionEnded } from '../src/runtime/server/ended-sessions'

/** A minimal JWT (header.payload.sig) carrying just `exp` — decoded, never verified. */
function jwt(exp: number): string {
  const seg = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${seg({ alg: 'HS256' })}.${seg({ exp })}.sig`
}
const freshJwt = () => jwt(Math.floor(Date.now() / 1000) + 3600)
const expiredJwt = () => jwt(Math.floor(Date.now() / 1000) - 10)

/** A mock H3 event exposing just the request cookie header `replaceRequestCookie` rewrites. */
function ev(cookieHeader?: string): H3Event {
  const headers = new Map<string, unknown>()
  return {
    context: {},
    node: {
      req: { headers: cookieHeader === undefined ? {} : { cookie: cookieHeader } },
      res: {
        getHeader: (k: string) => headers.get(k),
        setHeader: (k: string, v: unknown) => { headers.set(k, v) },
        removeHeader: (k: string) => { headers.delete(k) },
      },
    },
  } as unknown as H3Event
}

function configure(over: Record<string, unknown> = {}) {
  __test.runtimeConfig.lukk = { sessionPassword: 'p'.repeat(32), cookieSecure: true, baseURL: 'https://lukk/auth', ...over } as unknown as Record<string, unknown>
}

beforeEach(() => {
  cookieValue = 'sealed'
  noteValue = undefined
  unsealResult = { data: {} }
  unsealThrows = false
  sessionObj = { id: 'sid', data: {}, update: sessionUpdate }
  configure()
  refreshOnce.mockReset()
  vi.clearAllMocks()
})
afterEach(() => { __test.reset(); forgetEndedSessions() })

describe('resolveHydrationAccess', () => {
  it('returns a still-valid access token unchanged — no rotate, no session opened (no cookie mint)', async () => {
    const access = freshJwt()
    unsealResult = { data: { access, refresh: 'r' } }

    expect(await resolveHydrationAccess(ev())).toBe(access)
    expect(useSession).not.toHaveBeenCalled()
    expect(refreshOnce).not.toHaveBeenCalled()
  })

  it('returns null for an anonymous request (no sealed cookie) without opening the session', async () => {
    cookieValue = undefined
    expect(await resolveHydrationAccess(ev())).toBeNull()
    expect(useSession).not.toHaveBeenCalled()
  })

  it('returns null when the session password is unset (cannot unseal)', async () => {
    configure({ sessionPassword: undefined })
    expect(await resolveHydrationAccess(ev())).toBeNull()
    expect(useSession).not.toHaveBeenCalled()
  })

  it('returns null when the lukk server config is absent (defensive)', async () => {
    ;(__test.runtimeConfig as { lukk?: unknown }).lukk = undefined
    expect(await resolveHydrationAccess(ev())).toBeNull()
  })

  it('renders signed out — but per-user — while the browser\'s logout note is on the request, even if lukk couldn\'t be told yet', async () => {
    unsealResult = { data: { access: freshJwt(), refresh: 'r' } }
    noteValue = '1'
    expect(await resolveHydrationAccess(ev())).toBeNull()
    expect(useSession).not.toHaveBeenCalled()
    expect(setResponseHeader).toHaveBeenCalledWith(expect.anything(), 'cache-control', 'no-store')
    expect(getCookie).toHaveBeenCalledWith(expect.anything(), '__Host-lukk-logout')
  })

  it('treats a tampered/expired seal as no session', async () => {
    unsealThrows = true
    expect(await resolveHydrationAccess(ev())).toBeNull()
    expect(useSession).not.toHaveBeenCalled()
  })

  it('treats an unseal carrying no data as no session', async () => {
    unsealResult = {}
    expect(await resolveHydrationAccess(ev())).toBeNull()
  })

  it('returns null when the access token is expired but the session has no refresh token', async () => {
    unsealResult = { data: { access: expiredJwt() } }
    expect(await resolveHydrationAccess(ev())).toBeNull()
    expect(useSession).not.toHaveBeenCalled()
  })

  it('returns null when refreshable but baseURL is unset (misconfigured) — never opens the session', async () => {
    configure({ baseURL: '' })
    unsealResult = { data: { access: expiredJwt(), refresh: 'r' } }
    expect(await resolveHydrationAccess(ev())).toBeNull()
    expect(useSession).not.toHaveBeenCalled()
  })

  it('rotates an expired-but-refreshable session, reseals it, and mirrors the fresh seal into the request cookie', async () => {
    unsealResult = { data: { access: expiredJwt(), refresh: 'r' } }
    refreshOnce.mockResolvedValue({ pair: { access: 'NEW_ACCESS', refresh: 'r2' }, retryable: false })
    const event = ev('locale=en; __Host-lukk-session=STALE;') // trailing ';' → empty segment dropped

    const result = await resolveHydrationAccess(event)

    expect(result).toBe('NEW_ACCESS')
    // Rotates through the shared single-flight, keyed on the real session (id from the seal).
    expect(refreshOnce).toHaveBeenCalledWith(sessionObj, 'https://lukk/auth', '')
    // Reseals onto the RESPONSE (h3 update → Set-Cookie the browser receives).
    expect(sessionUpdate).toHaveBeenCalledWith({ access: 'NEW_ACCESS', refresh: 'r2' })
    // Mirrors the fresh seal into the in-process REQUEST cookie: the stale session is swapped,
    // other cookies kept — so the same render's fetchUser forwards the already-rotated session
    // and the app-API proxy injects the new access instead of replaying the just-rotated token.
    expect(event.node.req.headers.cookie).toBe('locale=en; __Host-lukk-session=FRESH_SEAL')
  })

  it('mirrors just the fresh seal when the request carried no cookie header', async () => {
    unsealResult = { data: { access: expiredJwt(), refresh: 'r' } }
    refreshOnce.mockResolvedValue({ pair: { access: 'NEW', refresh: 'r2' }, retryable: false })
    const event = ev()

    expect(await resolveHydrationAccess(event)).toBe('NEW')
    expect(event.node.req.headers.cookie).toBe('__Host-lukk-session=FRESH_SEAL')
  })

  it('uses the module-resolved name + non-Secure session in http dev (relaxed lukk-session)', async () => {
    // In dev http (cookieSecure:false) the name derives to the relaxed `lukk-session` and the reseal
    // keeps Secure off on the cookie it writes — prefix and attribute from the one `secure`.
    configure({ cookieSecure: false })
    unsealResult = { data: { access: expiredJwt(), refresh: 'r' } }
    refreshOnce.mockResolvedValue({ pair: { access: 'NEW', refresh: 'r2' }, retryable: false })
    const event = ev('lukk-session=STALE')

    await resolveHydrationAccess(event)

    expect(useSession).toHaveBeenCalledWith(event, expect.objectContaining({
      name: 'lukk-session',
      cookie: expect.objectContaining({ secure: false }),
    }))
    expect(sealSession).toHaveBeenCalledWith(event, { password: 'p'.repeat(32), name: 'lukk-session' })
    expect(event.node.req.headers.cookie).toBe('lukk-session=FRESH_SEAL')
  })

  it('reseals under a per-app namespaced cookie name, ignoring a co-hosted app\'s cookie', async () => {
    configure({ cookieNamespace: 'admin' }) // → __Host-lukk-admin-session
    unsealResult = { data: { access: expiredJwt(), refresh: 'r' } }
    refreshOnce.mockResolvedValue({ pair: { access: 'NEW', refresh: 'r2' }, retryable: false })
    // A co-hosted app's default-named cookie rides along in the header; it must be preserved,
    // and only THIS app's namespaced cookie swapped for the fresh seal.
    const event = ev('__Host-lukk-session=OTHERAPP; __Host-lukk-admin-session=STALE')

    await resolveHydrationAccess(event)

    expect(useSession).toHaveBeenCalledWith(event, expect.objectContaining({ name: '__Host-lukk-admin-session' }))
    expect(sealSession).toHaveBeenCalledWith(event, { password: 'p'.repeat(32), name: '__Host-lukk-admin-session' })
    expect(event.node.req.headers.cookie).toBe('__Host-lukk-session=OTHERAPP; __Host-lukk-admin-session=FRESH_SEAL')
  })

  it('carries the visitor IP into the SSR refresh, so lukk\'s /refresh throttle keys on them', async () => {
    // Every authenticated full page load whose token aged out lands here — the highest-volume auth
    // call in BFF mode. Without the visitor's address they all share lukk's one 30/60s bucket.
    configure({ clientIpHeader: 'cf-connecting-ip' })
    unsealResult = { data: { access: expiredJwt(), refresh: 'r' } }
    refreshOnce.mockResolvedValue({ pair: { access: 'NEW', refresh: 'r2' }, retryable: false })
    const event = ev()
    ;(event as unknown as { headers: Record<string, string> }).headers = { 'cf-connecting-ip': '198.51.100.23' }

    await resolveHydrationAccess(event)

    expect(refreshOnce).toHaveBeenCalledWith(sessionObj, 'https://lukk/auth', '198.51.100.23')
  })

  it('returns null (defers to the client) when the refresh fails or the session was revoked', async () => {
    unsealResult = { data: { access: expiredJwt(), refresh: 'r' } }
    refreshOnce.mockResolvedValue({ pair: null, retryable: false })

    expect(await resolveHydrationAccess(ev())).toBeNull()
    expect(sessionUpdate).not.toHaveBeenCalled()
  })

  it('does not refresh a session a sign-in replaced or a logout ended — re-sealing it would put it back', async () => {
    unsealResult = { data: { access: expiredJwt(), refresh: 'r' } }
    markSessionEnded('sid')

    expect(await resolveHydrationAccess(ev())).toBeNull()
    expect(refreshOnce).not.toHaveBeenCalled()
    expect(sessionUpdate).not.toHaveBeenCalled()
  })

  it('does not re-seal a session that ended while the render was refreshing it — and revokes what it minted', async () => {
    unsealResult = { data: { access: expiredJwt(), refresh: 'r' } }
    refreshOnce.mockImplementation(async () => {
      markSessionEnded('sid')
      return { pair: { access: 'NEW_ACCESS', refresh: 'r2' }, retryable: false }
    })
    const event = ev()

    expect(await resolveHydrationAccess(event)).toBeNull()
    expect(sessionUpdate).not.toHaveBeenCalled()
    expect(revokeDroppedSession).toHaveBeenCalledWith(event, { access: 'NEW_ACCESS', refresh: 'r2' }, 'https://lukk/auth', '')
  })

  it('revokes nothing on a render that hydrated a still-valid token, and a re-sealed one only once', async () => {
    unsealResult = { data: { access: freshJwt(), sid: 'session-A' } }
    const event = ev()
    await resolveHydrationAccess(event)
    markSessionEnded('session-A')
    await withholdIfReplaced(event)
    expect(revokeDroppedSession).not.toHaveBeenCalled()

    // A re-sealed one revokes exactly once, though the check runs after the user load AND at render end.
    unsealResult = { data: { access: expiredJwt(), refresh: 'r' } }
    refreshOnce.mockResolvedValue({ pair: { access: 'NEW_ACCESS', refresh: 'r2' }, retryable: false })
    const resealedEvent = ev()
    await resolveHydrationAccess(resealedEvent)
    markSessionEnded('sid')
    await withholdIfReplaced(resealedEvent)
    await withholdIfReplaced(resealedEvent)
    expect(revokeDroppedSession).toHaveBeenCalledOnce()
  })

  describe('a session a sign-in replaced or a logout ended', () => {
    it('is not rendered as signed in when sealed before `sid` existed, recognised by h3\'s id', async () => {
      // Its replacement is recorded under h3's id; checking only `sid` rendered it as the old account.
      unsealResult = { id: 'h3-legacy', data: { access: freshJwt(), refresh: 'r' } } as typeof unsealResult
      markSessionEnded('h3-legacy')

      expect(await resolveHydrationAccess(ev())).toBeNull()
    })

    it('is not rendered as signed in, even while its access token is still valid', async () => {
      // The tab would show that account while every call it makes acts as the newer session.
      unsealResult = { data: { access: freshJwt(), refresh: 'r', sid: 'session-A' } }
      markSessionEnded('session-A')
      const event = ev()

      expect(await resolveHydrationAccess(event)).toBeNull()
      // Still per-user: components fetching during SSR render its data through the app-API proxy.
      expect(setResponseHeader).toHaveBeenCalledWith(event, 'cache-control', 'no-store')
    })

    it('marks nothing no-store for a visitor with no session', async () => {
      unsealResult = { data: {} }

      await resolveHydrationAccess(ev())

      expect(setResponseHeader).not.toHaveBeenCalled()
    })

    it('is reported ended when that happens during the render, for a fresh and a re-sealed token alike', async () => {
      unsealResult = { data: { access: freshJwt(), sid: 'session-A' } }
      const fresh = ev()
      expect(await resolveHydrationAccess(fresh)).not.toBeNull()
      expect(await hydratedSessionEnded(fresh)).toBe(false)

      markSessionEnded('session-A')
      expect(await hydratedSessionEnded(fresh)).toBe(true)
      expect(await hydratedSessionEnded(ev())).toBe(false) // a render that hydrated nothing
    })
  })

  describe('withholdIfReplaced — the last check before the page response goes out', () => {
    async function resealed(): Promise<H3Event> {
      unsealResult = { data: { access: expiredJwt(), refresh: 'r' } }
      refreshOnce.mockResolvedValue({ pair: { access: 'NEW_ACCESS', refresh: 'r2' }, retryable: false })
      const event = ev()
      await resolveHydrationAccess(event)
      event.node.res.setHeader('set-cookie', ['__Host-lukk-session=RESEALED; Path=/', 'locale=en; Path=/', '__Host-lukk-session-other=1; Path=/'])
      return event
    }

    it('withholds the re-sealed cookie when a sign-in or logout ended that session during the render', async () => {
      const event = await resealed()
      markSessionEnded('sid')

      await withholdIfReplaced(event)

      // And revokes the tokens that re-seal minted, so a browser still holding the old cookie can't
      // replay a consumed refresh token into a false theft report.
      expect(revokeDroppedSession).toHaveBeenCalledWith(event, { access: 'NEW_ACCESS', refresh: 'r2' }, 'https://lukk/auth', '')
      // Only this app's cookie — not a co-hosted app's whose name merely starts the same way.
      expect(event.node.res.getHeader('set-cookie')).toEqual(['locale=en; Path=/', '__Host-lukk-session-other=1; Path=/'])
    })

    it('removes the header entirely when the session cookie was the only one', async () => {
      const event = await resealed()
      event.node.res.setHeader('set-cookie', '__Host-lukk-session=RESEALED; Path=/')
      markSessionEnded('sid')

      await withholdIfReplaced(event)

      expect(event.node.res.getHeader('set-cookie')).toBeUndefined()
    })

    it('leaves the cookie alone when the session is still current', async () => {
      const event = await resealed()

      await withholdIfReplaced(event)

      expect(event.node.res.getHeader('set-cookie')).toHaveLength(3)
    })

    it('leaves a response that has already started alone — a streamed render runs the hooks too late', async () => {
      const event = await resealed()
      markSessionEnded('sid')
      ;(event.node.res as unknown as { headersSent: boolean }).headersSent = true

      await expect(withholdIfReplaced(event)).resolves.toBeUndefined()
      expect(event.node.res.getHeader('set-cookie')).toHaveLength(3)
    })

    it('does not throw when the response starts between the check and the write', async () => {
      const event = await resealed()
      markSessionEnded('sid')
      event.node.res.setHeader = () => { throw new Error('ERR_HTTP_HEADERS_SENT') }

      await expect(withholdIfReplaced(event)).resolves.toBeUndefined()
    })

    it('does nothing for a render that re-sealed nothing, or queued no cookie', async () => {
      const event = await resealed()
      event.node.res.removeHeader('set-cookie')
      markSessionEnded('sid')
      await withholdIfReplaced(event)
      expect(event.node.res.getHeader('set-cookie')).toBeUndefined()

      const untouched = ev()
      untouched.node.res.setHeader('set-cookie', ['__Host-lukk-session=CURRENT'])
      await withholdIfReplaced(untouched)
      expect(untouched.node.res.getHeader('set-cookie')).toEqual(['__Host-lukk-session=CURRENT'])
    })
  })

  it('returns null when the refresh throws, rather than breaking the SSR render', async () => {
    unsealResult = { data: { access: expiredJwt(), refresh: 'r' } }
    refreshOnce.mockRejectedValue(new Error('network'))

    expect(await resolveHydrationAccess(ev())).toBeNull()
  })
})

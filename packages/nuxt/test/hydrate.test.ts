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

const getCookie = vi.fn(() => cookieValue)
const unsealSession = vi.fn(async () => { if (unsealThrows) throw new Error('bad seal'); return unsealResult })
const useSession = vi.fn(async () => sessionObj)
const sealSession = vi.fn(async () => 'FRESH_SEAL')

vi.mock('h3', () => ({
  getCookie: (...a: unknown[]) => getCookie(...a),
  unsealSession: (...a: unknown[]) => unsealSession(...a),
  useSession: (...a: unknown[]) => useSession(...a),
  sealSession: (...a: unknown[]) => sealSession(...a),
}))

const refreshOnce = vi.fn<(s: unknown, b: string) => Promise<TokenSession | null>>()
vi.mock('../src/runtime/server/utils/refresh', () => ({ refreshOnce: (...a: unknown[]) => refreshOnce(...(a as [unknown, string])) }))

// eslint-disable-next-line import/first
import { resolveHydrationAccess } from '../src/runtime/server/hydrate'

/** A minimal JWT (header.payload.sig) carrying just `exp` — decoded, never verified. */
function jwt(exp: number): string {
  const seg = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${seg({ alg: 'HS256' })}.${seg({ exp })}.sig`
}
const freshJwt = () => jwt(Math.floor(Date.now() / 1000) + 3600)
const expiredJwt = () => jwt(Math.floor(Date.now() / 1000) - 10)

/** A mock H3 event exposing just the request cookie header `replaceRequestCookie` rewrites. */
function ev(cookieHeader?: string): H3Event {
  return { node: { req: { headers: cookieHeader === undefined ? {} : { cookie: cookieHeader } } } } as unknown as H3Event
}

function configure(over: Record<string, unknown> = {}) {
  __test.runtimeConfig.lukk = { sessionPassword: 'p'.repeat(32), cookieSecure: true, baseURL: 'https://lukk/auth', ...over } as unknown as Record<string, unknown>
}

beforeEach(() => {
  cookieValue = 'sealed'
  unsealResult = { data: {} }
  unsealThrows = false
  sessionObj = { id: 'sid', data: {}, update: sessionUpdate }
  configure()
  refreshOnce.mockReset()
  vi.clearAllMocks()
})
afterEach(() => __test.reset())

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
    refreshOnce.mockResolvedValue({ access: 'NEW_ACCESS', refresh: 'r2' })
    const event = ev('locale=en; __Host-lukk-session=STALE;') // trailing ';' → empty segment dropped

    const result = await resolveHydrationAccess(event)

    expect(result).toBe('NEW_ACCESS')
    // Rotates through the shared single-flight, keyed on the real session (id from the seal).
    expect(refreshOnce).toHaveBeenCalledWith(sessionObj, 'https://lukk/auth')
    // Reseals onto the RESPONSE (h3 update → Set-Cookie the browser receives).
    expect(sessionUpdate).toHaveBeenCalledWith({ access: 'NEW_ACCESS', refresh: 'r2' })
    // Mirrors the fresh seal into the in-process REQUEST cookie: the stale session is swapped,
    // other cookies kept — so the same render's fetchUser forwards the already-rotated session
    // and the app-API proxy injects the new access instead of replaying the just-rotated token.
    expect(event.node.req.headers.cookie).toBe('locale=en; __Host-lukk-session=FRESH_SEAL')
  })

  it('mirrors just the fresh seal when the request carried no cookie header', async () => {
    unsealResult = { data: { access: expiredJwt(), refresh: 'r' } }
    refreshOnce.mockResolvedValue({ access: 'NEW', refresh: 'r2' })
    const event = ev()

    expect(await resolveHydrationAccess(event)).toBe('NEW')
    expect(event.node.req.headers.cookie).toBe('__Host-lukk-session=FRESH_SEAL')
  })

  it('uses the relaxed cookie name + non-Secure session in http dev (cookieSecure: false)', async () => {
    configure({ cookieSecure: false })
    unsealResult = { data: { access: expiredJwt(), refresh: 'r' } }
    refreshOnce.mockResolvedValue({ access: 'NEW', refresh: 'r2' })
    const event = ev('lukk-session=STALE')

    await resolveHydrationAccess(event)

    expect(useSession).toHaveBeenCalledWith(event, expect.objectContaining({
      name: 'lukk-session',
      cookie: expect.objectContaining({ secure: false }),
    }))
    expect(sealSession).toHaveBeenCalledWith(event, { password: 'p'.repeat(32), name: 'lukk-session' })
    expect(event.node.req.headers.cookie).toBe('lukk-session=FRESH_SEAL')
  })

  it('returns null (defers to the client) when the refresh fails or the session was revoked', async () => {
    unsealResult = { data: { access: expiredJwt(), refresh: 'r' } }
    refreshOnce.mockResolvedValue(null)

    expect(await resolveHydrationAccess(ev())).toBeNull()
    expect(sessionUpdate).not.toHaveBeenCalled()
  })

  it('returns null when the refresh throws, rather than breaking the SSR render', async () => {
    unsealResult = { data: { access: expiredJwt(), refresh: 'r' } }
    refreshOnce.mockRejectedValue(new Error('network'))

    expect(await resolveHydrationAccess(ev())).toBeNull()
  })
})

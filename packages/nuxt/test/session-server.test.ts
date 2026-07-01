import { afterEach, describe, expect, it, vi } from 'vitest'
import { ACCESS_KEY } from '../src/runtime/keys'
import { __test, useState } from './mocks/imports'

const fetchUser = vi.fn()
const loggedIn = { value: false }
const getLukkAccessToken = vi.fn()
const setResponseHeader = vi.fn()

vi.mock('h3', () => ({ setResponseHeader: (...a: unknown[]) => setResponseHeader(...a) }))
vi.mock('../src/runtime/composables/useLukkAuth', () => ({ useLukkAuth: () => ({ fetchUser, loggedIn }) }))
vi.mock('../src/runtime/server/utils/session', () => ({ getLukkAccessToken: (...a: unknown[]) => getLukkAccessToken(...a) }))

// eslint-disable-next-line import/first
import serverPlugin from '../src/runtime/plugins/session.server'
// eslint-disable-next-line import/first
import { accessExpired } from '../src/runtime/server/access-token'

const run = (nuxtApp: unknown) => (serverPlugin as unknown as (app: unknown) => Promise<void>)(nuxtApp)

/** A minimal `h.<payload>.s` JWT — only the middle segment (exp) is read, never verified. */
function token(exp: number | null): string {
  const body = Buffer.from(JSON.stringify(exp === null ? {} : { exp })).toString('base64url')
  return `h.${body}.s`
}
const fresh = () => token(Math.floor(Date.now() / 1000) + 3600)
const expired = () => token(Math.floor(Date.now() / 1000) - 10)

function app(o: { serverRendered?: boolean, prerenderedAt?: unknown, ssrContext?: unknown } = {}) {
  return {
    payload: { serverRendered: o.serverRendered ?? true, prerenderedAt: o.prerenderedAt },
    ssrContext: 'ssrContext' in o ? o.ssrContext : { event: {} },
  }
}

afterEach(() => { __test.reset(); loggedIn.value = false; vi.clearAllMocks() })

describe('session.server (BFF SSR hydration)', () => {
  it('seeds the user and marks the render no-store for a fresh, authenticated session', async () => {
    getLukkAccessToken.mockResolvedValue(fresh())
    fetchUser.mockImplementation(async () => { loggedIn.value = true })

    await run(app())

    expect(fetchUser).toHaveBeenCalledOnce()
    expect(setResponseHeader).toHaveBeenCalledWith(expect.anything(), 'cache-control', 'no-store')
    // Invariant: the plugin seeds identity via `fetchUser` only — the access token is never
    // written into the SSR-serialized state.
    expect(useState(ACCESS_KEY, () => null).value).toBeNull()
  })

  it('does not mark no-store when the user endpoint yields no user', async () => {
    getLukkAccessToken.mockResolvedValue(fresh())
    fetchUser.mockResolvedValue(undefined) // loggedIn stays false

    await run(app())

    expect(fetchUser).toHaveBeenCalledOnce()
    expect(setResponseHeader).not.toHaveBeenCalled()
  })

  it('skips hydration when the access token is expired (defers to the client restore)', async () => {
    getLukkAccessToken.mockResolvedValue(expired())
    await run(app())
    expect(fetchUser).not.toHaveBeenCalled()
    expect(setResponseHeader).not.toHaveBeenCalled()
  })

  it('skips when there is no sealed session (anonymous request)', async () => {
    getLukkAccessToken.mockResolvedValue(null)
    await run(app())
    expect(fetchUser).not.toHaveBeenCalled()
  })

  it('skips a prerendered page (would bake one user into a shared payload)', async () => {
    await run(app({ prerenderedAt: 12345 }))
    expect(getLukkAccessToken).not.toHaveBeenCalled()
  })

  it('skips a non-server-rendered pass', async () => {
    await run(app({ serverRendered: false }))
    expect(getLukkAccessToken).not.toHaveBeenCalled()
  })

  it('skips when the request event is absent', async () => {
    await run(app({ ssrContext: { event: undefined } }))
    expect(getLukkAccessToken).not.toHaveBeenCalled()
  })

  it('skips when there is no ssr context at all', async () => {
    await run(app({ ssrContext: undefined }))
    expect(getLukkAccessToken).not.toHaveBeenCalled()
  })
})

describe('accessExpired', () => {
  it('is true for a malformed token', () => expect(accessExpired('nope')).toBe(true))
  it('is true when exp is missing', () => expect(accessExpired(token(null))).toBe(true))
  it('is true when the payload segment is not valid JSON', () =>
    expect(accessExpired(`h.${Buffer.from('notjson').toString('base64url')}.s`)).toBe(true))
  it('is true within the 10s skew window', () =>
    expect(accessExpired(token(Math.floor(Date.now() / 1000) + 5))).toBe(true))
  it('is false for a comfortably-valid token', () => expect(accessExpired(fresh())).toBe(false))
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { __test } from './mocks/imports'

const captured: {
  hooks?: Record<string, (...a: unknown[]) => unknown>
  client?: { refreshTokens: ReturnType<typeof vi.fn> }
} = {}
vi.mock('lukk-core', async importActual => ({
  ...(await importActual<typeof import('lukk-core')>()),
  createLukkClient: vi.fn((hooks: Record<string, (...a: unknown[]) => unknown>) => {
    captured.hooks = hooks
    captured.client = { refreshTokens: vi.fn().mockResolvedValue({ access_token: 'fresh', expires_in: 900 }) }
    return captured.client
  }),
}))

const initSession = vi.fn()
const loggedIn = { value: false }
vi.mock('../src/runtime/composables/useLukkAuth', () => ({ useLukkAuth: () => ({ initSession, loggedIn }) }))

// eslint-disable-next-line import/first
import clientPlugin from '../src/runtime/plugins/client'
// eslint-disable-next-line import/first
import sessionPlugin from '../src/runtime/plugins/session.client'

afterEach(() => { __test.reset(); captured.hooks = undefined; loggedIn.value = false; vi.clearAllMocks() })

describe('client plugin', () => {
  it('targets the lukk URL in direct mode and wires the token hooks', async () => {
    __test.runtimeConfig.public.lukk = { mode: 'direct', baseURL: 'https://api/auth', confirmationHeader: 'X-Lukk-Confirmation' }
    const result = (clientPlugin as unknown as () => { provide: { lukk: unknown } })()
    const h = captured.hooks!

    expect(result.provide.lukk).toBeDefined()
    expect(h.baseURL).toBe('https://api/auth')
    expect(await h.getAccessToken()).toBeNull()
    expect(await h.getConfirmationToken()).toBeNull()
    await h.onTokens({ access_token: 'a', expires_in: 900 })
    expect(await h.getAccessToken()).toBe('a')
    h.onUnauthenticated()
    expect(await h.getAccessToken()).toBeNull()
    expect(await h.refresh()).toEqual({ access_token: 'fresh', expires_in: 900 })
  })

  it('targets the local proxy in bff mode', () => {
    __test.runtimeConfig.public.lukk = { mode: 'bff', baseURL: '', confirmationHeader: 'X-Lukk-Confirmation' }
    ;(clientPlugin as unknown as () => unknown)()
    expect(captured.hooks!.baseURL).toBe('/api/_lukk')
  })

  it('provides $lukkRefresh as ONE single-flight shared with the client (concurrent → one refresh)', async () => {
    __test.runtimeConfig.public.lukk = { mode: 'direct', baseURL: 'https://api/auth', confirmationHeader: 'X' }
    const { provide } = (clientPlugin as unknown as () => { provide: { lukkRefresh: () => Promise<unknown> } })()

    const [a, b] = await Promise.all([provide.lukkRefresh(), provide.lukkRefresh()])
    expect(a).toEqual({ access_token: 'fresh', expires_in: 900 })
    expect(b).toBe(a)
    expect(captured.client!.refreshTokens).toHaveBeenCalledTimes(1)
    // the shared refresh also updated the in-memory access token
    expect(await captured.hooks!.getAccessToken()).toBe('fresh')
  })

  it('$lukkRefresh resolves null when the refresh fails', async () => {
    __test.runtimeConfig.public.lukk = { mode: 'direct', baseURL: 'https://api/auth', confirmationHeader: 'X' }
    const { provide } = (clientPlugin as unknown as () => { provide: { lukkRefresh: () => Promise<unknown> } })()
    captured.client!.refreshTokens.mockRejectedValueOnce(new Error('revoked'))
    expect(await provide.lukkRefresh()).toBeNull()
  })
})

describe('session.client plugin', () => {
  it('restores the session on load when not already logged in', async () => {
    await (sessionPlugin as unknown as () => Promise<void>)()
    expect(initSession).toHaveBeenCalledOnce()
  })

  it('skips the client restore when SSR already hydrated the user', async () => {
    loggedIn.value = true
    await (sessionPlugin as unknown as () => Promise<void>)()
    expect(initSession).not.toHaveBeenCalled()
  })
})

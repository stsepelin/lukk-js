import { afterEach, describe, expect, it, vi } from 'vitest'
import { __test } from './mocks/imports'

const captured: { hooks?: Record<string, (...a: unknown[]) => unknown> } = {}
vi.mock('lukk-core', () => ({
  createLukkClient: vi.fn((hooks: Record<string, (...a: unknown[]) => unknown>) => {
    captured.hooks = hooks
    return { refreshTokens: vi.fn().mockResolvedValue({ access_token: 'fresh', expires_in: 900 }) }
  }),
}))

const initSession = vi.fn()
vi.mock('../src/runtime/composables/useLukkAuth', () => ({ useLukkAuth: () => ({ initSession }) }))

// eslint-disable-next-line import/first
import clientPlugin from '../src/runtime/plugins/client'
// eslint-disable-next-line import/first
import sessionPlugin from '../src/runtime/plugins/session.client'

afterEach(() => { __test.reset(); captured.hooks = undefined; vi.clearAllMocks() })

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
})

describe('session.client plugin', () => {
  it('restores the session on load', async () => {
    await (sessionPlugin as unknown as () => Promise<void>)()
    expect(initSession).toHaveBeenCalledOnce()
  })
})

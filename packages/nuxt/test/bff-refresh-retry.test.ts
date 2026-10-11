import { afterEach, describe, expect, it, vi } from 'vitest'
import { __test } from './mocks/imports'

// REAL lukk-core (no mock): the defect sat between the binding's refresh and core's retry, which only
// shows when both are the real thing.
const fetchUser = vi.fn()
vi.mock('../src/runtime/composables/useLukkAuth', () => ({ useLukkAuth: () => ({ fetchUser, user: { value: null } }) }))

// eslint-disable-next-line import/first
import clientPlugin from '../src/runtime/plugins/client'

afterEach(() => { __test.reset(); vi.unstubAllGlobals() })

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('a 401 in bff mode, after the proxy renewed the session', () => {
  it('is retried once and succeeds, with no token stored anywhere', async () => {
    __test.runtimeConfig.public.lukk = { mode: 'bff', baseURL: '', confirmationHeader: 'X-Lukk-Confirmation' }
    let reads = 0
    const fetch = vi.fn(async (url: string) => {
      if (url === '/api/_lukk/refresh') return json({ ok: true, expires_in: 900 })
      return ++reads === 1 ? json({ message: 'Unauthenticated.' }, 401) : json({ passkeys: [] })
    })
    vi.stubGlobal('fetch', fetch)
    const { provide } = (clientPlugin as unknown as () => { provide: { lukk: { request: (p: string) => Promise<unknown> } } })()

    expect(await provide.lukk.request('/passkeys')).toEqual({ passkeys: [] })
    expect(fetch.mock.calls.map(call => call[0])).toEqual(['/api/_lukk/passkeys', '/api/_lukk/refresh', '/api/_lukk/passkeys'])
    expect(fetch.mock.calls.every(call => !new Headers((call[1] as RequestInit).headers).has('authorization'))).toBe(true)
  })

  it('still rejects when the renewal is refused', async () => {
    __test.runtimeConfig.public.lukk = { mode: 'bff', baseURL: '', confirmationHeader: 'X-Lukk-Confirmation' }
    const fetch = vi.fn(async () => json({ message: 'Unauthenticated.' }, 401))
    vi.stubGlobal('fetch', fetch)
    const { provide } = (clientPlugin as unknown as () => { provide: { lukk: { request: (p: string) => Promise<unknown> } } })()

    await expect(provide.lukk.request('/passkeys')).rejects.toMatchObject({ status: 401 })
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})

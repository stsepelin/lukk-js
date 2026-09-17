import { afterEach, describe, expect, it, vi } from 'vitest'
import { ACCESS_KEY } from '../src/runtime/keys'
import { REFRESH_SETTLE_TIMEOUT } from '../src/runtime/utils/restore-state'
import { __test, useState } from './mocks/imports'

// The REAL lukk-core client and the REAL plugin + composable, with only `fetch` stubbed. The bug this
// pins lived in the handoff between core's own 401 retry and the plugin's refresh gate — a test that
// mocked either side (as the session-generation suite mocks core) could not see it.
vi.mock('../src/runtime/composables/useLukkFetch', () => ({ useLukkFetch: () => vi.fn() }))

// eslint-disable-next-line import/first
import clientPlugin from '../src/runtime/plugins/client'
// eslint-disable-next-line import/first
import { useLukkAuth } from '../src/runtime/composables/useLukkAuth'

const json = (body: unknown, status = 200) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function boot(mode: 'direct' | 'bff', lukk: (path: string, init: RequestInit) => Response) {
  const calls: { path: string, bearer: string | null }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const path = new URL(String(url), 'https://app.test').pathname.replace(/^\/(auth|api\/_lukk)/, '')
    calls.push({ path, bearer: new Headers(init.headers).get('authorization') })
    return lukk(path, init)
  }))
  __test.runtimeConfig.public.lukk = { mode, baseURL: 'https://api.test/auth', confirmationHeader: 'X-Lukk-Confirmation', userEndpoint: '', userKey: '' }
  const { provide } = (clientPlugin as unknown as () => { provide: Record<string, unknown> })()
  Object.assign(__test.nuxtApp, Object.fromEntries(Object.entries(provide).map(([k, v]) => [`$${k}`, v])))
  return calls
}

afterEach(() => { __test.reset(); vi.useRealTimers(); vi.unstubAllGlobals() })

describe('logout() with an access token lukk rejects', () => {
  it('renews it and logs out at once — it does not wait on itself for the settle timeout', async () => {
    // An idle user: the in-memory token expired. Core's refresh used to wait on this logout, which was
    // waiting on that refresh, until REFRESH_SETTLE_TIMEOUT broke the cycle.
    vi.useFakeTimers()
    let renewed = false
    const calls = boot('direct', (path) => {
      if (path === '/refresh') { renewed = true; return json({ access_token: 'fresh', expires_in: 900 }) }
      return renewed ? json(undefined, 204) : json({ message: 'Unauthenticated.' }, 401)
    })
    useState<string | null>(ACCESS_KEY, () => null).value = 'expired'
    const auth = useLukkAuth()

    let done = false
    const loggingOut = auth.logout().then(() => { done = true })
    await vi.advanceTimersByTimeAsync(0) // settle microtasks only; no timer may be needed

    expect(done).toBe(true)
    await loggingOut
    expect(calls).toEqual([
      { path: '/logout', bearer: 'Bearer expired' },
      { path: '/refresh', bearer: 'Bearer expired' },
      { path: '/logout', bearer: 'Bearer fresh' },
    ])
    expect(useState<string | null>(ACCESS_KEY, () => null).value).toBeNull()
  })

  it('fails fast when there is no session left to renew (an erased account, a revoked session)', async () => {
    vi.useFakeTimers()
    const calls = boot('bff', () => json({ message: 'Unauthenticated.' }, 401))
    const auth = useLukkAuth()
    auth.user.value = { id: 1 }

    let settled = false
    const loggingOut = auth.logout().catch((error: unknown) => { settled = true; return error })
    await vi.advanceTimersByTimeAsync(0)

    expect(settled).toBe(true)
    expect(await loggingOut).toMatchObject({ status: 401 })
    expect(calls.map(c => c.path)).toEqual(['/logout', '/refresh'])
    expect(auth.loggedIn.value).toBe(false)
  })

  it('does not renew for any other failure', async () => {
    vi.useFakeTimers()
    const calls = boot('direct', () => json({ message: 'Server Error' }, 500))

    await expect(useLukkAuth().logout()).rejects.toMatchObject({ status: 500 })
    expect(calls.map(c => c.path)).toEqual(['/logout'])
  })

  it('still holds back a refresh that starts while the retried logout is out', async () => {
    let answer!: (r: Response) => void
    let renewed = false
    const calls = boot('direct', (path) => {
      if (path === '/refresh') { renewed = true; return json({ access_token: 'fresh', expires_in: 900 }) }
      if (!renewed) return json({ message: 'Unauthenticated.' }, 401)
      return new Promise<Response>((resolve) => { answer = resolve }) as unknown as Response
    })
    useState<string | null>(ACCESS_KEY, () => null).value = 'expired'

    const loggingOut = useLukkAuth().logout()
    await new Promise(resolve => setTimeout(resolve, 0))
    const refreshing = (__test.nuxtApp as { $lukkRefresh: () => Promise<unknown> }).$lukkRefresh()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(calls.map(c => c.path)).toEqual(['/logout', '/refresh', '/logout'])

    answer(json(undefined, 204))
    await loggingOut
    await refreshing
    expect(calls.map(c => c.path)).toEqual(['/logout', '/refresh', '/logout', '/refresh'])
  })

  it(`resolves long before the ${REFRESH_SETTLE_TIMEOUT}ms cap when the retry succeeds`, async () => {
    let renewed = false
    boot('bff', (path) => {
      if (path === '/refresh') { renewed = true; return json({ ok: true, expires_in: 900 }) }
      return renewed ? json(undefined, 204) : json({ message: 'Unauthenticated.' }, 401)
    })
    const started = Date.now()

    await useLukkAuth().logout()

    expect(Date.now() - started).toBeLessThan(1_000)
  })
})

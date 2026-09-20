import { afterEach, describe, expect, it, vi } from 'vitest'
import { ACCESS_KEY } from '../src/runtime/keys'
import { REFRESH_SETTLE_TIMEOUT } from '../src/runtime/utils/restore-state'
import { __test, useState } from './mocks/imports'

// The REAL lukk-core client and the REAL plugin + composable, with only `fetch` stubbed. The bug this
// pins lived in the handoff between core's own 401 retry and the plugin's refresh gate — a test that
// mocked either side (as the session-generation suite mocks core) could not see it.
const { api } = vi.hoisted(() => ({ api: vi.fn() }))
vi.mock('../src/runtime/composables/useLukkFetch', () => ({ useLukkFetch: () => api }))

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

afterEach(() => { __test.reset(); vi.useRealTimers(); vi.unstubAllGlobals(); api.mockReset() })

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

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

  it('does not wait on itself under the cross-tab lock either — the renewal shares the logout\'s hold', async () => {
    vi.useFakeTimers()
    let requests = 0
    let held = false
    vi.stubGlobal('window', {})
    vi.stubGlobal('navigator', {
      locks: {
        request: (_name: string, _options: unknown, callback: () => Promise<void>) => {
          requests++
          if (held) return new Promise(() => {}) // a second acquisition would wait forever
          held = true
          return callback().finally(() => { held = false })
        },
      },
    })
    let renewed = false
    const calls = boot('direct', (path) => {
      if (path === '/refresh') { renewed = true; return json({ access_token: 'fresh', expires_in: 900 }) }
      return renewed ? json(undefined, 204) : json({ message: 'Unauthenticated.' }, 401)
    })
    useState<string | null>(ACCESS_KEY, () => null).value = 'expired'

    let done = false
    const loggingOut = useLukkAuth().logout().then(() => { done = true })
    await vi.advanceTimersByTimeAsync(0)

    expect(done).toBe(true)
    await loggingOut
    expect(requests).toBe(1)
    expect(calls.map(c => c.path)).toEqual(['/logout', '/refresh', '/logout'])
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

  it.each([
    ['a 500', () => json({ message: 'Server Error' }, 500)],
    ['a 403', () => json({ message: 'Forbidden.' }, 403)],
    ['a 429', () => json({ message: 'Too Many Attempts.' }, 429)],
  ])('does not renew for %s — only an expired token is renewable', async (_, answer) => {
    vi.useFakeTimers()
    const calls = boot('direct', answer)

    await expect(useLukkAuth().logout()).rejects.toBeDefined()
    expect(calls.map(c => c.path)).toEqual(['/logout'])
  })

  it('does not renew for a network failure either (it is sent once more without keepalive, then given up)', async () => {
    vi.useFakeTimers()
    const calls = boot('direct', () => { throw new TypeError('Failed to fetch') })

    await expect(useLukkAuth().logout()).rejects.toBeInstanceOf(TypeError)
    expect(calls.map(c => c.path)).toEqual(['/logout', '/logout'])
  })

  it('does not stall when another request\'s refresh started while the first attempt was out', async () => {
    // That refresh waited on the logout's hold; the renewal then joined it — each waiting on the other
    // until the settle cap. The hold is now per attempt, so the joined refresh goes out as soon as the
    // first attempt answers.
    vi.useFakeTimers()
    const firstAnswer = deferred<Response>()
    let renewed = false
    let logouts = 0
    const calls = boot('direct', (path) => {
      if (path === '/refresh') { renewed = true; return json({ access_token: 'fresh', expires_in: 900 }) }
      if (++logouts === 1) return firstAnswer.promise as unknown as Response
      return renewed ? json(undefined, 204) : json({ message: 'Unauthenticated.' }, 401)
    })
    useState<string | null>(ACCESS_KEY, () => null).value = 'expired'

    let done = false
    const loggingOut = useLukkAuth().logout().then(() => { done = true })
    await vi.advanceTimersByTimeAsync(0)
    const otherRequestsRefresh = (__test.nuxtApp as { $lukkRefresh: () => Promise<unknown> }).$lukkRefresh()
    await vi.advanceTimersByTimeAsync(0)
    expect(calls.map(c => c.path)).toEqual(['/logout']) // held while the first attempt is out

    firstAnswer.resolve(json({ message: 'Unauthenticated.' }, 401))
    await vi.advanceTimersByTimeAsync(0)

    expect(done).toBe(true)
    await Promise.all([loggingOut, otherRequestsRefresh])
    expect(calls.map(c => c.path)).toEqual(['/logout', '/refresh', '/logout'])
  })

  it('holds a sign-in back through the renewal gap, so the logout cannot sign the new session out', async () => {
    const renewal = deferred<Response>()
    let renewed = false
    const calls = boot('direct', (path) => {
      if (path === '/refresh') return renewal.promise.then((r) => { renewed = true; return r }) as unknown as Response
      if (path === '/login') return json({ access_token: 'B', refresh_token: 'rB', expires_in: 900 })
      return renewed ? json(undefined, 204) : json({ message: 'Unauthenticated.' }, 401)
    })
    useState<string | null>(ACCESS_KEY, () => null).value = 'expired'
    const auth = useLukkAuth()

    const loggingOut = auth.logout()
    await new Promise(resolve => setTimeout(resolve, 0)) // first attempt rejected; renewal on the wire
    const signingIn = auth.login({ email: 'b', password: 'p' })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(calls.map(c => c.path)).not.toContain('/login')

    renewal.resolve(json({ access_token: 'fresh', expires_in: 900 }))
    await Promise.all([loggingOut, signingIn])

    expect(calls.map(c => c.path)).toEqual(['/logout', '/refresh', '/logout', '/login'])
    expect(useState<string | null>(ACCESS_KEY, () => null).value).toBe('B')
  })

  it('does not let a user reload started by the renewal sign the user back in afterwards', async () => {
    // The renewal's refresh re-syncs a user that carries abilities. That reload captured the generation
    // the logout had already bumped, so landing after the logout it put the user back.
    const slowUser = deferred<unknown>()
    api.mockReturnValue(slowUser.promise)
    let renewed = false
    boot('direct', (path) => {
      if (path === '/refresh') { renewed = true; return json({ access_token: 'fresh', expires_in: 900 }) }
      return renewed ? json(undefined, 204) : json({ message: 'Unauthenticated.' }, 401)
    })
    __test.runtimeConfig.public.lukk.userEndpoint = '/me'
    useState<string | null>(ACCESS_KEY, () => null).value = 'expired'
    const auth = useLukkAuth()
    auth.user.value = { id: 1, abilities: ['orders.read'] }

    await auth.logout()
    expect(api).toHaveBeenCalled() // the reload is out
    slowUser.resolve({ id: 1, abilities: ['orders.read'] })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(auth.loggedIn.value).toBe(false)
  })

  it('still holds back a refresh that starts while the retried logout is out', async () => {
    let answer!: (r: Response) => void
    let renewed = false
    let logouts = 0
    const calls = boot('direct', (path) => {
      if (path === '/refresh') { renewed = true; return json({ access_token: 'fresh', expires_in: 900 }) }
      if (!renewed) return json({ message: 'Unauthenticated.' }, 401)
      if (++logouts > 1) return json(undefined, 204)
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
    // Released only once the logout answered — and, having raced a logout, that refresh's rotation is
    // ended too, with the token it minted.
    expect(calls.map(c => c.path)).toEqual(['/logout', '/refresh', '/logout', '/refresh', '/logout'])
    expect(calls.at(-1)!.bearer).toBe('Bearer fresh')
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

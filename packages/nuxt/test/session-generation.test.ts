import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ACCESS_KEY, CHALLENGE_KEY, RESTORE_FAILED_KEY, USER_KEY } from '../src/runtime/keys'
import { REFRESH_SETTLE_TIMEOUT, restoreState } from '../src/runtime/utils/restore-state'
import { __test, useState } from './mocks/imports'

// The REAL client plugin and the REAL composables, with only the wire stubbed: the races below live in
// the handover between the plugin's refresh single-flight and the composable's session state, and a
// test that mocked either side would pass for the wrong reason.
type Hooks = { onTokens: (pair: unknown) => void, onUnauthenticated: () => void, getAccessToken: () => string | null }
const wire = vi.hoisted(() => ({
  hooks: undefined as Hooks | undefined,
  client: {} as Record<string, ReturnType<typeof vi.fn>>,
}))

vi.mock('lukk-core', async importActual => ({
  ...(await importActual<typeof import('lukk-core')>()),
  createLukkClient: vi.fn((hooks: Hooks) => {
    wire.hooks = hooks
    return wire.client
  }),
  toRequestOptions: (json: unknown) => json,
  credentialToJSON: (credential: unknown) => credential,
}))

// The user endpoint: resolves to whichever account the bearer held when the request was SENT.
const { api } = vi.hoisted(() => ({ api: vi.fn() }))
vi.mock('../src/runtime/composables/useLukkFetch', () => ({ useLukkFetch: () => api }))

// eslint-disable-next-line import/first
import clientPlugin from '../src/runtime/plugins/client'
// eslint-disable-next-line import/first
import { useLukkAuth } from '../src/runtime/composables/useLukkAuth'
// eslint-disable-next-line import/first
import { useLukkPasskeys } from '../src/runtime/composables/useLukkPasskeys'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const pairFor = (account: string) => ({ access_token: account, expires_in: 900 })
const macrotask = () => new Promise(resolve => setTimeout(resolve, 0))
const access = () => useState<string | null>(ACCESS_KEY, () => null).value
const rawRestoreFailed = () => useState<boolean>(RESTORE_FAILED_KEY, () => false).value

/** A sign-in endpoint that, like lukk-core's `commit`, persists the pair it issued before resolving. */
const signsIn = (account: string) => vi.fn(async () => {
  const pair = pairFor(account)
  wire.hooks!.onTokens(pair)
  return pair
})

function boot(): void {
  __test.runtimeConfig.public.lukk = {
    mode: 'direct',
    baseURL: 'https://api/auth',
    confirmationHeader: 'X-Lukk-Confirmation',
    userEndpoint: 'https://app/me',
    userKey: '',
  }
  const { provide } = (clientPlugin as unknown as () => { provide: Record<string, unknown> })()
  Object.assign(__test.nuxtApp, Object.fromEntries(Object.entries(provide).map(([key, value]) => [`$${key}`, value])))
  ;(__test.nuxtApp as Record<string, unknown>).$lukk = wire.client
}

/** `/me` answers for the account whose token was attached, after `gate` opens. */
function userEndpoint(gates: Record<string, Promise<void>> = {}) {
  api.mockImplementation(async () => {
    const account = wire.hooks!.getAccessToken()
    await (account && gates[account])
    return { id: account }
  })
}

beforeEach(() => {
  wire.client = {
    refreshTokens: vi.fn(async () => pairFor('A')),
    login: signsIn('B'),
    register: signsIn('B'),
    twoFactorChallenge: signsIn('B'),
    loginWithPasskey: signsIn('B'),
    passkeyLoginOptions: vi.fn(async () => ({ ceremony_id: 'cer', options: {} })),
    logout: vi.fn(async () => undefined),
  }
  api.mockReset()
})
afterEach(() => { __test.reset(); wire.hooks = undefined; vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('a sign-in during an in-flight restore', () => {
  it('shows the account that signed in, not the one the restore loaded', async () => {
    // Reproduced in a real browser on Nuxt 3.13, 3.21 and 4.5: the screen said A while the token was B.
    const slowA = deferred<void>()
    userEndpoint({ A: slowA.promise })
    boot()
    const auth = useLukkAuth()

    const restoring = auth.initSession()
    await macrotask() // refresh done, token A, the restore is now waiting on `/me` for A
    await auth.login({ email: 'b', password: 'p' })
    expect(auth.user.value).toEqual({ id: 'B' })

    slowA.resolve()
    await restoring

    expect(auth.user.value).toEqual({ id: 'B' })
    expect(access()).toBe('B')
  })

  it('waits for a refresh already on the wire before sending the credentials', async () => {
    // Discarding the late refresh's RESULT is not enough: its response still sets the refresh cookie,
    // and landing after the login it put the previous session back under the new account.
    const flight = deferred<{ access_token: string }>()
    wire.client.refreshTokens!.mockReturnValueOnce(flight.promise)
    userEndpoint()
    boot()
    const auth = useLukkAuth()

    const restoring = auth.initSession()
    const signingIn = auth.login({ email: 'b', password: 'p' })
    await macrotask()
    expect(wire.client.login).not.toHaveBeenCalled()

    flight.resolve(pairFor('A'))
    await Promise.all([restoring, signingIn])

    expect(wire.client.login).toHaveBeenCalledOnce()
    expect(auth.user.value).toEqual({ id: 'B' })
    expect(access()).toBe('B')
  })

  it('does not wait forever for a refresh that never answers', async () => {
    vi.useFakeTimers()
    wire.client.refreshTokens!.mockReturnValueOnce(new Promise(() => {}))
    userEndpoint()
    boot()
    const auth = useLukkAuth()

    void auth.initSession()
    const signingIn = auth.login({ email: 'b', password: 'p' })
    await vi.advanceTimersByTimeAsync(REFRESH_SETTLE_TIMEOUT - 1)
    expect(wire.client.login).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    await signingIn

    expect(auth.user.value).toEqual({ id: 'B' })
  })

  it('drops a refresh that lands after the sign-in, so it cannot overwrite the new token', async () => {
    // The timeout path: the sign-in stopped waiting, and the old flight answered afterwards.
    vi.useFakeTimers()
    const flight = deferred<{ access_token: string }>()
    wire.client.refreshTokens!.mockReturnValueOnce(flight.promise)
    userEndpoint()
    boot()
    const auth = useLukkAuth()

    const restoring = auth.initSession()
    const signingIn = auth.login({ email: 'b', password: 'p' })
    await vi.advanceTimersByTimeAsync(REFRESH_SETTLE_TIMEOUT)
    await signingIn

    flight.resolve(pairFor('A'))
    await restoring

    expect(access()).toBe('B')
    expect(auth.user.value).toEqual({ id: 'B' })
    expect(auth.restoreFailed.value).toBe(false)
  })

  it('does not sign out the new session when a later restore joins the refresh it superseded', async () => {
    // "No session" clears the user on screen; "superseded" must not — it says nothing about the new one.
    vi.useFakeTimers()
    const flight = deferred<{ access_token: string }>()
    wire.client.refreshTokens!.mockReturnValueOnce(flight.promise)
    userEndpoint()
    boot()
    const auth = useLukkAuth()

    void auth.initSession()
    const signingIn = auth.login({ email: 'b', password: 'p' })
    await vi.advanceTimersByTimeAsync(REFRESH_SETTLE_TIMEOUT)
    await signingIn
    expect(auth.user.value).toEqual({ id: 'B' })

    const retry = auth.initSession() // joins the flight that started before the login
    flight.resolve(pairFor('A'))
    await retry

    expect(auth.user.value).toEqual({ id: 'B' })
  })

  it('does not report the superseded restore as a failure', async () => {
    // A retry that was throttled and answered after a login left the raw flag set under the new user,
    // hidden only while they stayed signed in.
    const flight = deferred<{ access_token: string }>()
    wire.client.refreshTokens!.mockReturnValueOnce(flight.promise)
    userEndpoint()
    boot()
    const auth = useLukkAuth()

    const restoring = auth.initSession()
    const signingIn = auth.login({ email: 'b', password: 'p' })
    flight.reject({ status: 429 })
    await Promise.all([restoring, signingIn])

    expect(rawRestoreFailed()).toBe(false)
  })

  it.each([
    ['register', (auth: ReturnType<typeof useLukkAuth>) => auth.register({ email: 'b', password: 'p', password_confirmation: 'p' })],
    ['a two-factor challenge', async (auth: ReturnType<typeof useLukkAuth>) => {
      useState<string | null>(CHALLENGE_KEY, () => null).value = 'challenge'
      await auth.verifyTwoFactor('123456')
    }],
    ['a recovery code', async (auth: ReturnType<typeof useLukkAuth>) => {
      useState<string | null>(CHALLENGE_KEY, () => null).value = 'challenge'
      await auth.verifyRecoveryCode('code')
    }],
    ['a passkey', async () => {
      vi.stubGlobal('navigator', { credentials: { get: vi.fn(async () => ({ id: 'credential' })) } })
      await useLukkPasskeys().login()
    }],
  ])('guards %s the same way as a password login', async (_, signIn) => {
    const slowA = deferred<void>()
    const flight = deferred<{ access_token: string }>()
    wire.client.refreshTokens!.mockReturnValueOnce(flight.promise)
    userEndpoint({ A: slowA.promise })
    boot()
    const auth = useLukkAuth()

    const restoring = auth.initSession()
    const signingIn = signIn(auth)
    await macrotask()
    // Waits for the refresh on the wire …
    expect(access()).toBeNull()

    flight.resolve(pairFor('A'))
    await signingIn
    // … and a restore still loading the previous account cannot land over the new one.
    slowA.resolve()
    await restoring

    expect(auth.user.value).toEqual({ id: 'B' })
    expect(access()).toBe('B')
  })

  it('clears a failed restore on an app with no user endpoint, where no user load would', async () => {
    wire.client.refreshTokens!.mockRejectedValueOnce({ status: 503 })
    boot()
    __test.runtimeConfig.public.lukk.userEndpoint = ''
    const auth = useLukkAuth()

    await auth.initSession()
    expect(auth.restoreFailed.value).toBe(true)

    await auth.login({ email: 'b', password: 'p' })

    expect(auth.restoreFailed.value).toBe(false)
  })
})

describe('a sign-in that did NOT start a session leaves the restore alone', () => {
  // The opposite defect: bumping the generation before the server answered would discard a restore that
  // was legitimately retrying, for a login that then failed.
  it.each([
    ['rejected credentials', () => { wire.client.login!.mockRejectedValueOnce({ status: 422 }) }],
    ['a two-factor challenge', () => { wire.client.login!.mockResolvedValueOnce({ two_factor: true, challenge_token: 'c' }) }],
  ])('%s', async (_, answer) => {
    const slowA = deferred<void>()
    userEndpoint({ A: slowA.promise })
    boot()
    answer()
    const auth = useLukkAuth()

    const restoring = auth.initSession()
    await macrotask()
    await auth.login({ email: 'b', password: 'p' }).catch(() => {})
    slowA.resolve()
    await restoring

    expect(auth.user.value).toEqual({ id: 'A' })
  })

  it('a registration still awaiting verification', async () => {
    const slowA = deferred<void>()
    userEndpoint({ A: slowA.promise })
    boot()
    wire.client.register!.mockResolvedValueOnce({ registered: true, requires_verification: true })
    const auth = useLukkAuth()

    const restoring = auth.initSession()
    await macrotask()
    await auth.register({ email: 'b', password: 'p', password_confirmation: 'p' })
    slowA.resolve()
    await restoring

    expect(auth.user.value).toEqual({ id: 'A' })
  })
})

describe('a logout during an in-flight refresh', () => {
  it('lets the refresh finish first, then drops its token', async () => {
    const flight = deferred<{ access_token: string }>()
    wire.client.refreshTokens!.mockReturnValueOnce(flight.promise)
    userEndpoint()
    boot()
    const auth = useLukkAuth()

    const restoring = auth.initSession()
    const loggingOut = auth.logout()
    await macrotask()
    // The refresh's cookie must not land after the logout cleared the session.
    expect(wire.client.logout).not.toHaveBeenCalled()

    flight.resolve(pairFor('A'))
    await Promise.all([restoring, loggingOut])

    expect(wire.client.logout).toHaveBeenCalledOnce()
    expect(access()).toBeNull()
    expect(auth.loggedIn.value).toBe(false)
  })

  it('does not sign back in when a restore joins the refresh the logout outlived', async () => {
    // Reproduced in a browser: initSession(), logout() 200ms later, initSession() at 400ms → signed in as A.
    const flight = deferred<{ access_token: string }>()
    wire.client.refreshTokens!.mockReturnValueOnce(flight.promise)
    userEndpoint()
    boot()
    const auth = useLukkAuth()

    const first = auth.initSession()
    const loggingOut = auth.logout()
    const second = auth.initSession() // joins the SAME flight, but started after the logout
    flight.resolve(pairFor('A'))
    await Promise.all([first, loggingOut, second])

    expect(wire.client.refreshTokens).toHaveBeenCalledOnce()
    expect(access()).toBeNull()
    expect(auth.loggedIn.value).toBe(false)
    expect(auth.restoreFailed.value).toBe(false)
  })

  it('reports a restore superseded by a finished logout as signed out, not as a failure', async () => {
    // The logout stopped waiting and finished; the restore joined the old flight after it. "The session
    // changed" is an answer — reporting it as unavailable would offer a retry to a visitor who just left.
    vi.useFakeTimers()
    const flight = deferred<{ access_token: string }>()
    wire.client.refreshTokens!.mockReturnValueOnce(flight.promise)
    userEndpoint()
    boot()
    const auth = useLukkAuth()

    void auth.initSession()
    const loggingOut = auth.logout()
    await vi.advanceTimersByTimeAsync(REFRESH_SETTLE_TIMEOUT)
    await loggingOut

    const retry = auth.initSession()
    flight.resolve(pairFor('A'))
    await retry

    expect(auth.loggedIn.value).toBe(false)
    expect(auth.restoreFailed.value).toBe(false)
  })

  it('does not show the restored user while the logout request is still out', async () => {
    const logoutSent = deferred<undefined>()
    wire.client.logout!.mockReturnValueOnce(logoutSent.promise)
    userEndpoint()
    boot()
    const auth = useLukkAuth()

    const restoring = auth.initSession()
    const loggingOut = auth.logout()
    await restoring
    await macrotask()

    expect(auth.loggedIn.value).toBe(false)

    logoutSent.resolve(undefined)
    await loggingOut
  })
})

describe('fetchUser against a session that changed while it loaded', () => {
  it('does not sign the user back in when logout() lands first', async () => {
    // Reproduced in a browser: login with a slow `/me`, logout 300ms later → loggedIn: true, token null,
    // and `lukk-auth` let the visitor through.
    const slowB = deferred<void>()
    userEndpoint({ B: slowB.promise })
    boot()
    const auth = useLukkAuth()

    const signingIn = auth.login({ email: 'b', password: 'p' })
    await macrotask()
    await auth.logout()
    slowB.resolve()
    await signingIn

    expect(auth.loggedIn.value).toBe(false)
  })

  it('does not sign out a newer session with a stale 401', async () => {
    let answer!: (error: unknown) => void
    api.mockResolvedValue({ id: 'B' })
    api.mockImplementationOnce(() => new Promise((_, reject) => { answer = reject }))
    boot()
    const auth = useLukkAuth()
    auth.user.value = { id: 'A' }

    const loading = auth.fetchUser()
    await auth.login({ email: 'b', password: 'p' })
    expect(auth.user.value).toEqual({ id: 'B' })
    answer({ statusCode: 401 })
    await loading

    expect(auth.loggedIn.value).toBe(true)
  })
})

describe('onUnauthenticated after a superseded refresh', () => {
  it('keeps the token of the session that replaced it', async () => {
    const flight = deferred<{ access_token: string }>()
    wire.client.refreshTokens!.mockReturnValueOnce(flight.promise)
    boot()
    const refresh = (__test.nuxtApp as { $lukkRefresh: () => Promise<unknown> }).$lukkRefresh

    const refreshing = refresh()
    restoreState(__test.nuxtApp).epoch++ // a sign-in answered meanwhile …
    wire.hooks!.onTokens(pairFor('B'))
    flight.reject({ status: 401 }) // … and the OLD session's refresh was rejected
    expect(await refreshing).toBeNull()
    wire.hooks!.onUnauthenticated() // what lukk-core does next

    expect(access()).toBe('B')
  })

  it('still clears the token when the refresh that failed was current', async () => {
    wire.client.refreshTokens!.mockRejectedValueOnce({ status: 401 })
    boot()
    wire.hooks!.onTokens(pairFor('A'))

    expect(await (__test.nuxtApp as { $lukkRefresh: () => Promise<unknown> }).$lukkRefresh()).toBeNull()
    wire.hooks!.onUnauthenticated()

    expect(access()).toBeNull()
  })
})

describe('gaps found by mutation testing', () => {
  it('clears a dead token after a sign-in, not only in the first session generation', async () => {
    // The flight must record the generation it runs in; frozen at the first, `onUnauthenticated` kept a
    // rejected token after any sign-in.
    boot()
    const auth = useLukkAuth()
    await auth.login({ email: 'b', password: 'p' })
    expect(access()).toBe('B')

    wire.client.refreshTokens!.mockRejectedValueOnce({ status: 401 })
    expect(await (__test.nuxtApp as { $lukkRefresh: () => Promise<unknown> }).$lukkRefresh()).toBeNull()
    wire.hooks!.onUnauthenticated()

    expect(access()).toBeNull()
  })

  it('a finished sign-in does not release a refresh held for a logout that is still out', async () => {
    const loginResponse = deferred<void>()
    const logoutResponse = deferred<void>()
    wire.client.login!.mockImplementationOnce(slowSignIn('B', loginResponse.promise, () => { throw { status: 422 } }))
    wire.client.logout!.mockImplementationOnce(async () => { await logoutResponse.promise })
    boot()
    const auth = useLukkAuth()

    const signingIn = auth.login({ email: 'b', password: 'p' }).catch(() => {})
    await macrotask()
    const loggingOut = auth.logout()
    await macrotask()
    loginResponse.resolve()
    await signingIn

    const refreshing = (__test.nuxtApp as { $lukkRefresh: () => Promise<unknown> }).$lukkRefresh()
    await macrotask()
    expect(wire.client.refreshTokens).not.toHaveBeenCalled()

    logoutResponse.resolve()
    await Promise.all([loggingOut, refreshing])
  })

  it('a finished logout does not release a refresh held for a sign-in that is still out', async () => {
    // Reachable when the sign-in stopped waiting for a slow logout (the settle cap) and went out first.
    vi.useFakeTimers()
    const logoutResponse = deferred<void>()
    const loginResponse = deferred<void>()
    wire.client.logout!.mockImplementationOnce(async () => { await logoutResponse.promise })
    wire.client.login!.mockImplementationOnce(slowSignIn('B', loginResponse.promise))
    userEndpoint()
    boot()
    const auth = useLukkAuth()

    const loggingOut = auth.logout()
    await vi.advanceTimersByTimeAsync(0)
    const signingIn = auth.login({ email: 'b', password: 'p' })
    await vi.advanceTimersByTimeAsync(REFRESH_SETTLE_TIMEOUT)
    expect(wire.client.login).toHaveBeenCalledOnce() // gave up waiting; now on the wire
    logoutResponse.resolve()
    await loggingOut

    const refreshing = (__test.nuxtApp as { $lukkRefresh: () => Promise<unknown> }).$lukkRefresh()
    await vi.advanceTimersByTimeAsync(0)
    expect(wire.client.refreshTokens).not.toHaveBeenCalled()

    loginResponse.resolve()
    await vi.advanceTimersByTimeAsync(0)
    await Promise.all([signingIn, refreshing])
  })

  it('a sign-in waits for a logout still on the wire, so the logout cannot sign the new session out', async () => {
    // The logout's cleanup and the cleared cookie in its response landed after the login succeeded.
    const logoutResponse = deferred<void>()
    wire.client.logout!.mockImplementationOnce(async () => { await logoutResponse.promise })
    userEndpoint()
    boot()
    const auth = useLukkAuth()

    const loggingOut = auth.logout()
    await macrotask()
    const signingIn = auth.login({ email: 'b', password: 'p' })
    await macrotask()
    expect(wire.client.login).not.toHaveBeenCalled()

    logoutResponse.resolve()
    await Promise.all([loggingOut, signingIn])

    expect(wire.client.login).toHaveBeenCalledOnce()
    expect(auth.user.value).toEqual({ id: 'B' })
    expect(access()).toBe('B')
  })

  it('a registration answered with a two-factor challenge leaves a restore in progress alone', async () => {
    const slowA = deferred<void>()
    userEndpoint({ A: slowA.promise })
    boot()
    wire.client.register!.mockResolvedValueOnce({ two_factor: true, challenge_token: 'c' })
    const auth = useLukkAuth()

    const restoring = auth.initSession()
    await macrotask()
    await auth.register({ email: 'b', password: 'p', password_confirmation: 'p' })
    slowA.resolve()
    await restoring

    expect(auth.user.value).toEqual({ id: 'A' })
  })
})

describe('after clearNuxtState()', () => {
  it('reads as signed out with nothing pending or failed, not the opposite', () => {
    // Nuxt 3 leaves each key `undefined`; a strict `!== null` read that as signed in with a challenge.
    boot()
    const auth = useLukkAuth()
    useState(USER_KEY, () => null).value = undefined
    useState(CHALLENGE_KEY, () => null).value = undefined
    useState(RESTORE_FAILED_KEY, () => false).value = undefined

    expect(auth.loggedIn.value).toBe(false)
    expect(auth.pendingTwoFactor.value).toBe(false)
    expect(auth.restoreFailed.value).toBe(false)
  })
})

/** A sign-in whose response is held until `open` resolves — the request is "on the wire" meanwhile. */
function slowSignIn(account: string, open: Promise<void>, answer: () => unknown = () => pairFor(account)) {
  return async () => {
    await open
    const result = answer()
    if (typeof result === 'object' && result && 'access_token' in result) wire.hooks!.onTokens(result)
    return result
  }
}

describe('a refresh that starts while a sign-in is on the wire', () => {
  it('is never sent when the sign-in starts a new session', async () => {
    // Sent, it carried the OLD session's cookie and could land after the login — setting that cookie
    // back under the new account.
    const response = deferred<void>()
    wire.client.login!.mockImplementationOnce(slowSignIn('B', response.promise))
    userEndpoint()
    boot()
    const auth = useLukkAuth()
    const refresh = (__test.nuxtApp as { $lukkRefresh: () => Promise<unknown> }).$lukkRefresh

    const signingIn = auth.login({ email: 'b', password: 'p' })
    await macrotask()
    const refreshing = refresh() // e.g. a request's 401 retry
    await macrotask()
    expect(wire.client.refreshTokens).not.toHaveBeenCalled()

    response.resolve()
    await signingIn

    expect(await refreshing).toBeNull()
    expect(wire.client.refreshTokens).not.toHaveBeenCalled()
    expect(access()).toBe('B')
    expect(auth.user.value).toEqual({ id: 'B' })
  })

  it('goes ahead once a sign-in that started no session has answered', async () => {
    const response = deferred<void>()
    wire.client.login!.mockImplementationOnce(slowSignIn('B', response.promise, () => { throw { status: 422 } }))
    boot()
    const auth = useLukkAuth()
    const refresh = (__test.nuxtApp as { $lukkRefresh: () => Promise<unknown> }).$lukkRefresh

    const signingIn = auth.login({ email: 'b', password: 'p' }).catch(() => {})
    await macrotask()
    const refreshing = refresh()
    response.resolve()
    await signingIn

    expect(await refreshing).toEqual(pairFor('A'))
    expect(access()).toBe('A')
  })
})

describe('a logout while a sign-in is on the wire', () => {
  function logoutSpy() {
    const bearers: (string | null)[] = []
    wire.client.logout!.mockImplementation(async () => { bearers.push(wire.hooks!.getAccessToken()) })
    return bearers
  }

  it.each([
    ['a password login', (auth: ReturnType<typeof useLukkAuth>) => auth.login({ email: 'b', password: 'p' }), 'login'],
    ['a registration', (auth: ReturnType<typeof useLukkAuth>) => auth.register({ email: 'b', password: 'p', password_confirmation: 'p' }), 'register'],
    ['a two-factor challenge', (auth: ReturnType<typeof useLukkAuth>) => {
      useState<string | null>(CHALLENGE_KEY, () => null).value = 'challenge'
      return auth.verifyTwoFactor('123456')
    }, 'twoFactorChallenge'],
    ['a passkey login', () => {
      vi.stubGlobal('navigator', { credentials: { get: vi.fn(async () => ({ id: 'credential' })) } })
      return useLukkPasskeys().login()
    }, 'loginWithPasskey'],
  ])('ends the session %s issued afterwards, instead of signing in', async (_, signIn, endpoint) => {
    // Reproduced: logout bumped the generation, the login landed and began a NEW one, its user load
    // passed the check, and the visitor ended up signed in with no token and a revoked session.
    const response = deferred<void>()
    wire.client[endpoint]!.mockImplementationOnce(slowSignIn('B', response.promise))
    const bearers = logoutSpy()
    userEndpoint()
    boot()
    const auth = useLukkAuth()

    const signingIn = signIn(auth)
    await macrotask()
    await auth.logout()
    expect(bearers).toEqual([null])

    response.resolve()
    await signingIn

    // A second logout, carrying the session the server just issued — the first could not end it.
    expect(bearers).toEqual([null, 'B'])
    expect(api).not.toHaveBeenCalled()
    expect(auth.loggedIn.value).toBe(false)
    expect(access()).toBeNull()
  })

  it.each([
    ['a two-factor challenge', () => ({ two_factor: true, challenge_token: 'c' })],
    ['rejected credentials', () => { throw { status: 422 } }],
  ])('sends no second logout when the answer was %s', async (_, answer) => {
    const response = deferred<void>()
    wire.client.login!.mockImplementationOnce(slowSignIn('B', response.promise, answer))
    const bearers = logoutSpy()
    boot()
    const auth = useLukkAuth()

    const signingIn = auth.login({ email: 'b', password: 'p' }).catch(() => {})
    await macrotask()
    await auth.logout()
    response.resolve()
    await signingIn

    expect(bearers).toEqual([null])
    expect(auth.pendingTwoFactor.value).toBe(false)
  })

  it('does not end a session that a registration never issued', async () => {
    const response = deferred<void>()
    wire.client.register!.mockImplementationOnce(slowSignIn('B', response.promise, () => ({ registered: true, requires_verification: true })))
    const bearers = logoutSpy()
    boot()
    const auth = useLukkAuth()

    const registering = auth.register({ email: 'b', password: 'p', password_confirmation: 'p' })
    await macrotask()
    await auth.logout()
    response.resolve()
    await registering

    expect(bearers).toEqual([null])
  })
})

describe('logout() and the refresh it waits for', () => {
  it('authenticates the logout with the token that refresh just minted', async () => {
    // Ending the generation BEFORE waiting threw that token away, and the logout then went out with an
    // expired one and had to refresh again through its own 401.
    const flight = deferred<{ access_token: string }>()
    wire.client.refreshTokens!.mockReturnValueOnce(flight.promise)
    const bearers: (string | null)[] = []
    wire.client.logout!.mockImplementation(async () => { bearers.push(wire.hooks!.getAccessToken()) })
    boot()
    const refresh = (__test.nuxtApp as { $lukkRefresh: () => Promise<unknown> }).$lukkRefresh

    void refresh()
    const loggingOut = useLukkAuth().logout()
    flight.resolve(pairFor('A'))
    await loggingOut

    expect(bearers).toEqual(['A'])
    expect(access()).toBeNull()
  })
})

describe('a refresh that starts while logout() is on the wire', () => {
  it('waits for the logout, so it cannot renew the session being ended', async () => {
    // Sent alongside, it rotated the session before the logout reached the server and wrote the token back.
    const response = deferred<void>()
    wire.client.logout!.mockImplementationOnce(async () => { await response.promise })
    boot()
    const auth = useLukkAuth()
    const refresh = (__test.nuxtApp as { $lukkRefresh: () => Promise<unknown> }).$lukkRefresh

    const loggingOut = auth.logout()
    await macrotask()
    const refreshing = refresh()
    await macrotask()
    expect(wire.client.refreshTokens).not.toHaveBeenCalled()

    // The logout cleared the cookie, so the refresh that follows is rejected.
    wire.client.refreshTokens!.mockRejectedValueOnce({ status: 401 })
    response.resolve()
    await loggingOut

    expect(await refreshing).toBeNull()
    expect(wire.client.refreshTokens).toHaveBeenCalledOnce()
    expect(access()).toBeNull()
  })
})

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

function boot(mode: 'direct' | 'bff' = 'direct'): void {
  __test.runtimeConfig.public.lukk = {
    mode,
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
    claimSession: vi.fn(async () => undefined),
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
    // Two capped waits — the whole logout, then its request on the wire — before it gives up.
    await vi.advanceTimersByTimeAsync(REFRESH_SETTLE_TIMEOUT * 2)
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

  it('a finished logout does not release sign-ins held for a second logout still renewing its token', async () => {
    // In the renewal gap nothing but the whole-logout hold keeps a sign-in out; the first logout must
    // not clear the second one's.
    const first = deferred<void>()
    const renewal = deferred<{ access_token: string }>()
    wire.client.logout!
      .mockImplementationOnce(async () => { await first.promise })
      .mockImplementationOnce(async () => { throw { status: 401 } })
      .mockImplementationOnce(async () => undefined)
    wire.client.refreshTokens!.mockReturnValueOnce(renewal.promise)
    boot()
    const auth = useLukkAuth()

    const firstLogout = auth.logout()
    await macrotask()
    const secondLogout = auth.logout()
    await macrotask() // second attempt rejected; its renewal is on the wire
    expect(wire.client.refreshTokens).toHaveBeenCalledOnce()
    first.resolve()
    await firstLogout

    const signingIn = auth.login({ email: 'b', password: 'p' })
    await macrotask()
    expect(wire.client.login).not.toHaveBeenCalled()

    renewal.resolve(pairFor('A'))
    // The first logout ended the generation that renewal belonged to, so the second rejects — the session
    // was already revoked by the first.
    await Promise.all([secondLogout.catch(() => {}), signingIn])
    expect(wire.client.login).toHaveBeenCalledOnce()
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

describe('a sign-in or logout in another tab', () => {
  // A stand-in for the browser's BroadcastChannel: only created where `window` has one.
  class FakeChannel {
    static instances: FakeChannel[] = []
    posted: unknown[] = []
    onmessage: ((event: MessageEvent) => void) | null = null
    constructor(public name: string) { FakeChannel.instances.push(this) }
    postMessage(message: unknown) { this.posted.push(message) }
  }
  const otherTabSays = async () => {
    FakeChannel.instances.at(-1)!.onmessage!({ data: 'changed' } as MessageEvent)
    await macrotask()
  }

  beforeEach(() => {
    FakeChannel.instances = []
    vi.stubGlobal('window', { BroadcastChannel: FakeChannel })
  })

  it('announces a sign-in and a logout to other tabs', async () => {
    userEndpoint()
    boot()
    const auth = useLukkAuth()
    const channel = FakeChannel.instances[0]!
    expect(channel.name).toBe('lukk:session:/')

    await auth.login({ email: 'b', password: 'p' })
    expect(channel.posted).toEqual(['changed'])
    await auth.logout()
    expect(channel.posted).toEqual(['changed', 'changed'])
  })

  it('BFF: reloads the user, so the tab stops showing the account it loaded', async () => {
    // The browser's cookie now belongs to the other tab's session; a BFF tab holds no token to notice.
    api.mockResolvedValue({ id: 'B' })
    boot('bff')
    const auth = useLukkAuth()
    auth.user.value = { id: 'A' }

    await otherTabSays()

    expect(auth.user.value).toEqual({ id: 'B' })
    expect(wire.client.refreshTokens).not.toHaveBeenCalled()
  })

  it('direct: renews from the shared cookie first, then reloads the user', async () => {
    wire.client.refreshTokens!.mockResolvedValueOnce(pairFor('B'))
    userEndpoint()
    boot()
    const auth = useLukkAuth()
    auth.user.value = { id: 'A' }
    useState<string | null>(ACCESS_KEY, () => null).value = 'A'

    await otherTabSays()

    expect(access()).toBe('B')
    expect(auth.user.value).toEqual({ id: 'B' })
  })

  it('direct: signs out when the other tab logged out, but keeps the user when it could not tell', async () => {
    boot()
    const auth = useLukkAuth()
    useState<string | null>(ACCESS_KEY, () => null).value = 'A'

    auth.user.value = { id: 'A' }
    wire.client.refreshTokens!.mockRejectedValueOnce({ status: 503 })
    await otherTabSays()
    expect(auth.user.value).toEqual({ id: 'A' })

    wire.client.refreshTokens!.mockRejectedValueOnce({ status: 401 })
    await otherTabSays()
    expect(auth.user.value).toBeNull()
    expect(access()).toBeNull()
  })

  it('direct: asks again when its first restore joined a refresh from before the change', async () => {
    const stale = deferred<{ access_token: string }>()
    wire.client.refreshTokens!.mockReturnValueOnce(stale.promise).mockResolvedValueOnce(pairFor('B'))
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })))
    userEndpoint()
    boot()
    const auth = useLukkAuth()
    auth.user.value = { id: 'A' }

    void (__test.nuxtApp as { $lukkRefresh: () => Promise<unknown> }).$lukkRefresh()
    await macrotask() // under way — holding the lock, on the wire — when the other tab's change arrives
    FakeChannel.instances.at(-1)!.onmessage!({ data: 'changed' } as MessageEvent)
    stale.resolve(pairFor('A2'))
    await macrotask()
    await macrotask()

    expect(wire.client.refreshTokens).toHaveBeenCalledTimes(2)
    expect(auth.user.value).toEqual({ id: 'B' })
  })

  it('keeps a logout this tab never finished — the other tab may have only failed to log out; a sign-in there is told apart by its record', async () => {
    const store = new Map<string, string>([['lukk:logging-out:/admin/', String(Date.now())]])
    vi.stubGlobal('sessionStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v) }, removeItem: (k: string) => { store.delete(k) } })
    api.mockResolvedValue({ id: 'B' })
    boot('bff')
    restoreState(__test.nuxtApp).scope = '/admin/'

    await otherTabSays()

    expect(store.has('lukk:logging-out:/admin/')).toBe(true)
  })

  it('drops what this tab still had in flight for the previous session', async () => {
    const slowA = deferred<void>()
    userEndpoint({ A: slowA.promise })
    boot('bff')
    const auth = useLukkAuth()
    useState<string | null>(ACCESS_KEY, () => null).value = 'A'
    api.mockImplementationOnce(async () => { await slowA.promise; return { id: 'A' } })

    const loading = auth.fetchUser()
    api.mockResolvedValue({ id: 'B' })
    await otherTabSays()
    slowA.resolve()
    await loading

    expect(auth.user.value).toEqual({ id: 'B' })
  })

  it('names its channel after the app\'s base, so apps sharing an origin don\'t re-check each other', () => {
    ;(__test.runtimeConfig as Record<string, unknown>).app = { baseURL: '/admin/' }
    boot()

    expect(FakeChannel.instances[0]!.name).toBe('lukk:session:/admin/')
    expect(restoreState(__test.nuxtApp).scope).toBe('/admin/')
  })

  it('does not listen where the browser has no BroadcastChannel', () => {
    vi.stubGlobal('window', {})
    boot()

    expect(FakeChannel.instances).toHaveLength(0)
    expect(restoreState(__test.nuxtApp).announce).toBeUndefined()
  })
})

describe('queued across tabs with a Web Lock', () => {
  function recordingLocks() {
    const names: string[] = []
    vi.stubGlobal('window', {})
    vi.stubGlobal('navigator', {
      locks: {
        request: (name: string, _options: unknown, callback: () => Promise<void>) => {
          names.push(name)
          return callback()
        },
      },
    })
    return names
  }

  it('takes the app\'s lock for a sign-in', async () => {
    const names = recordingLocks()
    userEndpoint()
    boot()

    await useLukkAuth().login({ email: 'b', password: 'p' })

    expect(names[0]).toBe('lukk:session:/')
  })

  it('takes it for a logout', async () => {
    const names = recordingLocks()
    boot()

    await useLukkAuth().logout()

    expect(names).toEqual(['lukk:session:/'])
  })

  it('takes it for a refresh', async () => {
    const names = recordingLocks()
    boot()

    await (__test.nuxtApp as { $lukkRefresh: () => Promise<unknown> }).$lukkRefresh()

    expect(names).toEqual(['lukk:session:/'])
  })
})

describe('a refresh that answers after its session was replaced (past the caps)', () => {
  it('direct: ends that rotation with the token it minted, and tells the other tabs', async () => {
    // Its response already set the refresh cookie, after the newer session's: kept, a reload (or this tab
    // following the other) would continue as the previous account.
    const flight = deferred<{ access_token: string }>()
    wire.client.refreshTokens!.mockReturnValueOnce(flight.promise)
    const revocations = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', revocations)
    boot()
    const announce = vi.fn()
    restoreState(__test.nuxtApp).announce = announce
    const refresh = (__test.nuxtApp as { $lukkRefresh: () => Promise<unknown> }).$lukkRefresh

    const refreshing = refresh()
    restoreState(__test.nuxtApp).epoch++ // a sign-in, here or in another tab, landed meanwhile
    flight.resolve(pairFor('A2'))

    expect(await refreshing).toBeNull()
    expect(revocations).toHaveBeenCalledWith('https://api/auth/logout', expect.objectContaining({
      method: 'POST',
      // Bearer only: the cookie may already be the newer session's.
      credentials: 'omit',
      headers: expect.objectContaining({ 'Authorization': 'Bearer A2', 'Content-Type': 'application/json' }),
    }))
    expect(announce).toHaveBeenCalledOnce()
    expect(access()).not.toBe('A2')
  })

  it('direct: still tells the other tabs when that logout can\'t be sent', async () => {
    const flight = deferred<{ access_token: string }>()
    wire.client.refreshTokens!.mockReturnValueOnce(flight.promise)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    boot()
    const announce = vi.fn()
    restoreState(__test.nuxtApp).announce = announce

    const refreshing = (__test.nuxtApp as { $lukkRefresh: () => Promise<unknown> }).$lukkRefresh()
    restoreState(__test.nuxtApp).epoch++
    flight.resolve(pairFor('A2'))

    expect(await refreshing).toBeNull()
    expect(announce).toHaveBeenCalledOnce()
  })

  it('BFF: leaves it to the proxy — the browser never holds that token', async () => {
    const flight = deferred<{ ok: boolean }>()
    wire.client.refreshTokens!.mockReturnValueOnce(flight.promise as never)
    const revocations = vi.fn()
    vi.stubGlobal('fetch', revocations)
    boot('bff')

    const refreshing = (__test.nuxtApp as { $lukkRefresh: () => Promise<unknown> }).$lukkRefresh()
    restoreState(__test.nuxtApp).epoch++
    flight.resolve({ ok: true })

    expect(await refreshing).toBeNull()
    expect(revocations).not.toHaveBeenCalled()
  })
})

describe('claiming the session a sign-in issued', () => {
  it.each([
    ['a password login', (auth: ReturnType<typeof useLukkAuth>) => auth.login({ email: 'b', password: 'p' })],
    ['a registration', (auth: ReturnType<typeof useLukkAuth>) => auth.register({ email: 'b', password: 'p', password_confirmation: 'p' })],
    ['a two-factor challenge', async (auth: ReturnType<typeof useLukkAuth>) => {
      useState<string | null>(CHALLENGE_KEY, () => null).value = 'challenge'
      await auth.verifyTwoFactor('123456')
    }],
    ['a passkey login', async () => {
      vi.stubGlobal('navigator', { credentials: { get: vi.fn(async () => ({ id: 'credential' })) } })
      await useLukkPasskeys().login()
    }],
  ])('claims it straight after %s', async (_, signIn) => {
    // With lukk's claim_seconds on, a session whose first use comes too late is revoked — which ends one
    // whose sign-in response never arrived, but would also end an app that simply stays idle.
    userEndpoint()
    boot()

    await signIn(useLukkAuth())

    expect(wire.client.claimSession).toHaveBeenCalledOnce()
  })

  it.each([
    ['rejected credentials', () => { wire.client.login!.mockRejectedValueOnce({ status: 422 }) }],
    ['a two-factor challenge', () => { wire.client.login!.mockResolvedValueOnce({ two_factor: true, challenge_token: 'c' }) }],
  ])('claims nothing after %s — no session was issued', async (_, answer) => {
    boot()
    answer()

    await useLukkAuth().login({ email: 'b', password: 'p' }).catch(() => {})

    expect(wire.client.claimSession).not.toHaveBeenCalled()
  })

  it('does not claim a session a logout during the sign-in ended', async () => {
    const response = deferred<void>()
    wire.client.login!.mockImplementationOnce(slowSignIn('B', response.promise))
    boot()
    const auth = useLukkAuth()

    const signingIn = auth.login({ email: 'b', password: 'p' })
    await macrotask()
    await auth.logout()
    response.resolve()
    await signingIn

    expect(wire.client.claimSession).not.toHaveBeenCalled()
  })

  it('ignores a lukk release without the route, and never delays or fails the sign-in', async () => {
    wire.client.claimSession!.mockRejectedValueOnce({ status: 404 })
    userEndpoint()
    boot()

    await expect(useLukkAuth().login({ email: 'b', password: 'p' })).resolves.toEqual(pairFor('B'))
  })
})

describe('a pending logout note and a later sign-in', () => {
  it('drops the note when someone signs in again in this tab — the old logout is moot', async () => {
    const store = new Map<string, string>([['lukk:logging-out:/admin/', String(Date.now())]])
    vi.stubGlobal('sessionStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v) }, removeItem: (k: string) => { store.delete(k) } })
    userEndpoint()
    boot()
    restoreState(__test.nuxtApp).scope = '/admin/'

    await useLukkAuth().login({ email: 'b', password: 'p' })

    expect(store.has('lukk:logging-out:/admin/')).toBe(false)
  })

  it('keeps a note for a logout asked for while this sign-in was already out — that logout still ends it', async () => {
    const store = new Map<string, string>()
    vi.stubGlobal('sessionStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v) }, removeItem: (k: string) => { store.delete(k) } })
    const answer = deferred<void>()
    userEndpoint()
    boot()
    const login = wire.client.login as ReturnType<typeof vi.fn>
    const original = login.getMockImplementation()!
    login.mockImplementationOnce(async (...args: unknown[]) => { await answer.promise; return original(...args) })

    const signingIn = useLukkAuth().login({ email: 'b', password: 'p' })
    await new Promise(resolve => setTimeout(resolve, 5))
    store.set('lukk:logging-out:/', String(Date.now()))
    answer.resolve()
    await signingIn

    expect(store.has('lukk:logging-out:/')).toBe(true)
  })

  it('records when the sign-in was SENT — a logout asked for while it was out still ends it', async () => {
    const shared = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (k: string) => shared.get(k) ?? null, setItem: (k: string, v: string) => { shared.set(k, v) } })
    const answer = deferred<void>()
    userEndpoint()
    boot()
    restoreState(__test.nuxtApp).scope = '/admin/' // recorded for this app only
    const login = wire.client.login as ReturnType<typeof vi.fn>
    const original = login.getMockImplementation()!
    login.mockImplementationOnce(async (...args: unknown[]) => { await answer.promise; return original(...args) })

    const signingIn = useLukkAuth().login({ email: 'b', password: 'p' })
    await macrotask()
    const asked = Date.now()
    await new Promise(resolve => setTimeout(resolve, 5))
    answer.resolve()
    await signingIn

    expect(Number(shared.get('lukk:signed-in-at:/admin/'))).toBeLessThanOrEqual(asked) // not when it was answered, 5 ms later
  })

  it('records the sign-in for every tab — a note left in a tab that navigated away is moot when it returns', async () => {
    const shared = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (k: string) => shared.get(k) ?? null, setItem: (k: string, v: string) => { shared.set(k, v) } })
    const before = Date.now()
    userEndpoint()
    boot()

    await useLukkAuth().login({ email: 'b', password: 'p' })

    expect(Number(shared.get('lukk:signed-in-at:/'))).toBeGreaterThanOrEqual(before)
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

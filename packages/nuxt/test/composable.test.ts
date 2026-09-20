import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { READY_KEY, RESTORE_FAILED_KEY } from '../src/runtime/keys'
import { restoreState } from '../src/runtime/utils/restore-state'
import { __test, useState } from './mocks/imports'

// fetchUser goes through useLukkFetch — mock it with a controllable fake.
const { api } = vi.hoisted(() => ({ api: vi.fn() }))
vi.mock('../src/runtime/composables/useLukkFetch', () => ({ useLukkFetch: () => api }))

// eslint-disable-next-line import/first
import { useLukkAuth } from '../src/runtime/composables/useLukkAuth'

type Restore = () => Promise<{ pair: unknown, unavailable: boolean }>
const signedOut: Restore = () => Promise.resolve({ pair: null, unavailable: false })

function withApp(lukk: Record<string, unknown>, lukkRestore: Restore = signedOut) {
  __test.nuxtApp = { $lukk: lukk, $lukkRestore: lukkRestore }
  __test.runtimeConfig.public.lukk = {
    mode: 'direct',
    baseURL: 'https://api/auth',
    confirmationHeader: 'X-Lukk-Confirmation',
    userEndpoint: 'https://app/me',
    userKey: 'data',
  }
}

beforeEach(() => { api.mockReset().mockResolvedValue({ id: 1, name: 'Ada' }) })
afterEach(() => { __test.reset(); vi.restoreAllMocks() })

describe('useLukkAuth', () => {
  it('logs in, then loads the user (loggedIn becomes true)', async () => {
    withApp({ login: vi.fn().mockResolvedValue({ access_token: 'a', expires_in: 900 }) })
    const { user, loggedIn, login } = useLukkAuth()

    const result = await login({ email: 'e', password: 'p' })

    expect((result as { access_token: string }).access_token).toBe('a')
    expect(user.value).toEqual({ id: 1, name: 'Ada' })
    expect(loggedIn.value).toBe(true)
  })

  it('returns a 2FA challenge without loading the user', async () => {
    withApp({ login: vi.fn().mockResolvedValue({ two_factor: true, challenge_token: 'c' }) })
    const { user, login } = useLukkAuth()

    expect(await login({ email: 'e', password: 'p' })).toEqual({ two_factor: true, challenge_token: 'c' })
    expect(user.value).toBeNull()
    expect(api).not.toHaveBeenCalled()
  })

  it('registers, then loads the user (auto-login, like login)', async () => {
    withApp({ register: vi.fn().mockResolvedValue({ access_token: 'a', expires_in: 900 }) })
    const { user, loggedIn, register } = useLukkAuth()

    const result = await register({ email: 'e', password: 'p', password_confirmation: 'p' })

    expect((result as { access_token: string }).access_token).toBe('a')
    expect(user.value).toEqual({ id: 1, name: 'Ada' })
    expect(loggedIn.value).toBe(true)
  })

  it('register surfaces a 2FA challenge when the new user is enrolled', async () => {
    withApp({ register: vi.fn().mockResolvedValue({ two_factor: true, challenge_token: 'c' }) })
    const { user, pendingTwoFactor, register } = useLukkAuth()

    expect(await register({ email: 'e', password: 'p', password_confirmation: 'p' }))
      .toEqual({ two_factor: true, challenge_token: 'c' })
    expect(pendingTwoFactor.value).toBe(true)
    expect(user.value).toBeNull()
    expect(api).not.toHaveBeenCalled()
  })

  it('register resolves without a session when verification is required', async () => {
    withApp({ register: vi.fn().mockResolvedValue({ registered: true, requires_verification: true }) })
    const { user, loggedIn, register } = useLukkAuth()

    expect(await register({ email: 'e', password: 'p', password_confirmation: 'p' }))
      .toEqual({ registered: true, requires_verification: true })
    expect(user.value).toBeNull()
    expect(loggedIn.value).toBe(false)
    expect(api).not.toHaveBeenCalled()
  })

  it('fetchUser loads the user via useLukkFetch (full path, no baseURL)', async () => {
    withApp({})
    const { user, fetchUser } = useLukkAuth()
    await fetchUser()
    expect(api).toHaveBeenCalledWith('https://app/me', { baseURL: '' })
    expect(user.value).toEqual({ id: 1, name: 'Ada' })
  })

  it('fetchUser logs out only on auth failures, not transient errors', async () => {
    withApp({})
    const { user, fetchUser } = useLukkAuth()

    await fetchUser()
    expect(user.value).toEqual({ id: 1, name: 'Ada' })

    // transient 5xx → keep the user (don't bounce a logged-in user to /login)
    api.mockRejectedValueOnce({ statusCode: 503 })
    await fetchUser()
    expect(user.value).toEqual({ id: 1, name: 'Ada' })

    // 403 (LukkError.status) → logged out
    api.mockRejectedValueOnce({ status: 403 })
    await fetchUser()
    expect(user.value).toBeNull()

    // reload, then 401 → logged out
    api.mockResolvedValueOnce({ id: 2, name: 'Bob' })
    await fetchUser()
    expect(user.value).toEqual({ id: 2, name: 'Bob' })
    api.mockRejectedValueOnce({ statusCode: 401 })
    await fetchUser()
    expect(user.value).toBeNull()
  })

  it('fetchUser skips when no endpoint is configured', async () => {
    withApp({})
    __test.runtimeConfig.public.lukk.userEndpoint = ''
    const { user, fetchUser } = useLukkAuth()
    await fetchUser()
    expect(api).not.toHaveBeenCalled()
    expect(user.value).toBeNull()
  })

  it('fetchUser signs the user out on a 401', async () => {
    // A user that is ALREADY null proves nothing, and a bare `new Error('401')` carries no status —
    // together they let this pass with the sign-out removed entirely.
    withApp({})
    const { user, fetchUser } = useLukkAuth()
    user.value = { id: 1 }
    api.mockRejectedValueOnce({ statusCode: 401 })

    await fetchUser()

    expect(user.value).toBeNull()
  })

  it('fetchUser keeps the user on a transient failure', async () => {
    withApp({})
    const { user, fetchUser } = useLukkAuth()
    user.value = { id: 1 }
    api.mockRejectedValueOnce({ statusCode: 503 })

    await fetchUser()

    expect(user.value).toEqual({ id: 1 })
  })

  it('records which account the loaded user belongs to, and forgets it on sign-out', async () => {
    const token = `h.${Buffer.from('{"sub":"7"}').toString('base64url')}.s`
    withApp({ logout: vi.fn().mockResolvedValue(undefined) })
    useState<string | null>('lukk:access', () => null).value = token
    const { fetchUser, logout } = useLukkAuth()

    await fetchUser()
    expect(restoreState(__test.nuxtApp).subject).toBe('7')

    api.mockRejectedValueOnce({ statusCode: 401 })
    await fetchUser()
    expect(restoreState(__test.nuxtApp).subject).toBeUndefined()

    await fetchUser()
    await logout()
    expect(restoreState(__test.nuxtApp).subject).toBeUndefined()
  })

  it('logout clears state on success', async () => {
    withApp({ logout: vi.fn().mockResolvedValue(undefined) })
    const { user, logout } = useLukkAuth()
    user.value = { id: 1 }
    await logout()
    expect(user.value).toBeNull()
  })

  it('logout clears state, even when the request rejects', async () => {
    withApp({ logout: vi.fn().mockRejectedValue(new Error('net')) })
    const { user, logout } = useLukkAuth()
    user.value = { id: 1 }
    await expect(logout()).rejects.toThrow('net')
    expect(user.value).toBeNull()
  })

  it('revokeOtherSessions delegates to the client', async () => {
    const revoke = vi.fn().mockResolvedValue(undefined)
    withApp({ revokeOtherSessions: revoke })
    await useLukkAuth().revokeOtherSessions()
    expect(revoke).toHaveBeenCalledOnce()
  })

  it('initSession loads the user when the restore returns a session', async () => {
    const restore = vi.fn().mockResolvedValue({ pair: { access_token: 'a', expires_in: 900 }, unavailable: false })
    withApp({}, restore)
    const { user, initSession, restoreFailed } = useLukkAuth()
    await initSession()
    expect(restore).toHaveBeenCalledTimes(1)
    expect(user.value).toEqual({ id: 1, name: 'Ada' })
    expect(restoreFailed.value).toBe(false)
  })

  it('initSession does nothing without a session', async () => {
    withApp({})
    const { user, initSession, restoreFailed } = useLukkAuth()
    await initSession()
    expect(user.value).toBeNull()
    expect(api).not.toHaveBeenCalled()
    expect(restoreFailed.value).toBe(false)
  })

  it('surfaces a 2FA challenge on login and completes it with a TOTP code', async () => {
    const twoFactorChallenge = vi.fn().mockResolvedValue({ access_token: 'a', expires_in: 900 })
    withApp({ login: vi.fn().mockResolvedValue({ two_factor: true, challenge_token: 'ct' }), twoFactorChallenge })
    const { login, verifyTwoFactor, pendingTwoFactor } = useLukkAuth()

    await login({ email: 'e', password: 'p' })
    expect(pendingTwoFactor.value).toBe(true)

    await verifyTwoFactor('123456')
    expect(twoFactorChallenge).toHaveBeenCalledWith({ challenge_token: 'ct', code: '123456' })
    expect(pendingTwoFactor.value).toBe(false)
  })

  it('completes a 2FA challenge with a recovery code', async () => {
    const twoFactorChallenge = vi.fn().mockResolvedValue({ access_token: 'a', expires_in: 900 })
    withApp({ login: vi.fn().mockResolvedValue({ two_factor: true, challenge_token: 'ct' }), twoFactorChallenge })
    const { login, verifyRecoveryCode } = useLukkAuth()

    await login({ email: 'e', password: 'p' })
    await verifyRecoveryCode('RECOVERY-1')
    expect(twoFactorChallenge).toHaveBeenCalledWith({ challenge_token: 'ct', recovery_code: 'RECOVERY-1' })
  })

  it('throws when completing 2FA without a pending challenge', async () => {
    withApp({ twoFactorChallenge: vi.fn() })
    await expect(useLukkAuth().verifyTwoFactor('123')).rejects.toThrow('no pending')
  })

  describe('user shaping', () => {
    it('auto-unwraps a Laravel `{ data: {...} }` API-Resource wrapper', async () => {
      withApp({})
      api.mockResolvedValueOnce({ data: { id: 1, name: 'Ada' } })
      const { user, loggedIn, fetchUser } = useLukkAuth()
      await fetchUser()
      expect(user.value).toEqual({ id: 1, name: 'Ada' })
      expect(loggedIn.value).toBe(true)
    })

    it('unwraps a configured custom key', async () => {
      withApp({})
      __test.runtimeConfig.public.lukk.userKey = 'result'
      api.mockResolvedValueOnce({ result: { id: 2 } })
      const { user, fetchUser } = useLukkAuth()
      await fetchUser()
      expect(user.value).toEqual({ id: 2 })
    })

    it('stores the response as-is when unwrapping is disabled (key=false)', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {}) // no-id wrapper → expected dev warning
      withApp({})
      __test.runtimeConfig.public.lukk.userKey = ''
      api.mockResolvedValueOnce({ data: { id: 3 } })
      const { user, fetchUser } = useLukkAuth()
      await fetchUser()
      expect(user.value).toEqual({ data: { id: 3 } })
    })

    it('logs out on an explicit `{ data: null }` (no-user) response', async () => {
      withApp({})
      api.mockResolvedValueOnce({ data: null })
      const { user, loggedIn, fetchUser } = useLukkAuth()
      await fetchUser()
      expect(user.value).toBeNull()
      expect(loggedIn.value).toBe(false)
    })

    it('warns (dev) when the loaded user still looks like an un-unwrapped wrapper', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      withApp({})
      __test.runtimeConfig.public.lukk.userKey = '' // leave it wrapped, no id
      api.mockResolvedValueOnce({ data: { name: 'Ada' } })
      await useLukkAuth().fetchUser()
      expect(warn).toHaveBeenCalledOnce()
      expect(warn.mock.calls[0]![0]).toContain('user.endpoint')
    })

    it('does not warn for a well-shaped user', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      withApp({})
      api.mockResolvedValueOnce({ id: 1, name: 'Ada' })
      await useLukkAuth().fetchUser()
      expect(warn).not.toHaveBeenCalled()
    })
  })
})

describe('useLukkAuth — session readiness', () => {
  it('reports unresolved until the session plugins say otherwise', () => {
    withApp({})
    const { ready, loggedIn } = useLukkAuth()

    // Both false — which is exactly why `loggedIn` alone cannot mean "anonymous".
    expect(ready.value).toBe(false)
    expect(loggedIn.value).toBe(false)

    useState<boolean>(READY_KEY, () => false).value = true
    expect(ready.value).toBe(true)
  })

  it('whenReady() waits for the restore, then resolves', async () => {
    withApp({})
    const { whenReady } = useLukkAuth()
    let released = false
    void whenReady().then(() => { released = true })

    await nextTick()
    expect(released).toBe(false)

    useState<boolean>(READY_KEY, () => false).value = true
    await nextTick()
    await Promise.resolve()
    expect(released).toBe(true)
  })

  it('whenReady() resolves at once when the session is already resolved', async () => {
    withApp({})
    useState<boolean>(READY_KEY, () => false).value = true

    await expect(useLukkAuth().whenReady()).resolves.toBeUndefined()
  })

  it('stays resolved across a logout — signed out is still a resolved answer', async () => {
    withApp({ logout: vi.fn().mockResolvedValue(undefined) })
    useState<boolean>(READY_KEY, () => false).value = true
    const { ready, logout, loggedIn } = useLukkAuth()

    await logout()

    expect(loggedIn.value).toBe(false)
    expect(ready.value).toBe(true)
  })
})

describe('useLukkAuth — a restore that could not reach an answer', () => {
  const pair = { access_token: 'a', expires_in: 900 }

  it('reports it when the refresh itself was unavailable (throttled, 5xx, unreachable)', async () => {
    withApp({}, () => Promise.resolve({ pair: null, unavailable: true }))
    const { initSession, loggedIn, restoreFailed } = useLukkAuth()

    await initSession()

    // Signed out as far as the UI can tell — but the visitor may have a perfectly valid session.
    expect(loggedIn.value).toBe(false)
    expect(restoreFailed.value).toBe(true)
  })

  it('reports it when the refresh worked but the user endpoint then failed', async () => {
    // The session is VALID here; only loading the user failed. Reporting "signed out" would prompt a
    // signed-in user to log in again.
    withApp({}, () => Promise.resolve({ pair, unavailable: false }))
    api.mockRejectedValueOnce({ statusCode: 503 })
    const { initSession, loggedIn, restoreFailed } = useLukkAuth()

    await initSession()

    expect(loggedIn.value).toBe(false)
    expect(restoreFailed.value).toBe(true)
  })

  it('does NOT report it when the user endpoint says signed out (401/403)', async () => {
    withApp({}, () => Promise.resolve({ pair, unavailable: false }))
    api.mockRejectedValueOnce({ statusCode: 401 })
    const { initSession, restoreFailed } = useLukkAuth()

    await initSession()

    expect(restoreFailed.value).toBe(false)
  })

  it('clears it when a retry succeeds', async () => {
    const restore = vi.fn()
      .mockResolvedValueOnce({ pair: null, unavailable: true })
      .mockResolvedValueOnce({ pair, unavailable: false })
    withApp({}, restore)
    const { initSession, loggedIn, restoreFailed } = useLukkAuth()

    await initSession()
    expect(restoreFailed.value).toBe(true)

    await initSession()
    expect(loggedIn.value).toBe(true)
    expect(restoreFailed.value).toBe(false)
  })

  it('is hidden while someone is signed in, and cleared by logout', async () => {
    withApp({ logout: vi.fn().mockResolvedValue(undefined) }, () => Promise.resolve({ pair: null, unavailable: true }))
    const { initSession, user, logout, restoreFailed } = useLukkAuth()
    await initSession()
    expect(restoreFailed.value).toBe(true)

    user.value = { id: 1 } // e.g. a later successful login
    expect(restoreFailed.value).toBe(false)

    await logout()
    // Signing out is a definitive answer — the earlier failure must not resurface.
    expect(restoreFailed.value).toBe(false)
  })

  it('does not report a failure when the restore provide is missing entirely', async () => {
    // An ordering gap degrades to signed-out, as before. Calling it "unavailable" would invite a
    // retry loop that can never succeed.
    __test.nuxtApp = { $lukk: {} }
    __test.runtimeConfig.public.lukk = { mode: 'direct', baseURL: '', confirmationHeader: 'X', userEndpoint: '/me', userKey: '' }
    const { initSession, restoreFailed } = useLukkAuth()

    await initSession()

    expect(restoreFailed.value).toBe(false)
  })
})

describe('useLukkAuth — restoreFailed tracks the LATEST definitive answer', () => {
  const pair = { access_token: 'a', expires_in: 900 }
  const raw = () => useState<boolean>(RESTORE_FAILED_KEY, () => false)

  it('does not resurface after a later session ends', async () => {
    // Boot restore fails, the user signs in, and later that session dies. Only hiding the flag while
    // signed in left the stale `true` underneath, so it came back — and middleware gating a redirect on
    // it let the now signed-out visitor through.
    withApp({}, () => Promise.resolve({ pair: null, unavailable: true }))
    const { initSession, fetchUser, loggedIn, restoreFailed } = useLukkAuth()
    await initSession()
    expect(restoreFailed.value).toBe(true)

    await fetchUser() // e.g. the load inside a successful login()
    expect(loggedIn.value).toBe(true)
    expect(raw().value).toBe(false) // cleared, not merely hidden

    api.mockRejectedValueOnce({ statusCode: 401 }) // the session later ends
    await fetchUser()
    expect(loggedIn.value).toBe(false)
    expect(restoreFailed.value).toBe(false)
  })

  it('leaves no failure behind a successful restore, even one hidden by the signed-in user', async () => {
    // `restoreFailed` hides the flag while someone is signed in, so a successful load that SET it went
    // unnoticed — until the user was nulled by anything other than logout().
    withApp({}, () => Promise.resolve({ pair: { access_token: 'a' }, unavailable: false }))
    const { initSession } = useLukkAuth()

    await initSession()

    expect(useState<boolean>(RESTORE_FAILED_KEY, () => false).value).toBe(false)
  })

  it('clears it when a plain fetchUser() is answered 401', async () => {
    withApp({}, () => Promise.resolve({ pair: null, unavailable: true }))
    const { initSession, fetchUser, restoreFailed } = useLukkAuth()
    await initSession()
    expect(restoreFailed.value).toBe(true)

    api.mockRejectedValueOnce({ statusCode: 401 })
    await fetchUser()

    expect(restoreFailed.value).toBe(false)
  })

  it('signs a still-displayed user out when a retry is answered "no session"', async () => {
    // Another tab logged out: this tab's retry learns the session is gone, and must stop showing it.
    withApp({}, () => Promise.resolve({ pair: null, unavailable: false }))
    const { initSession, user, loggedIn } = useLukkAuth()
    user.value = { id: 1 }

    await initSession()

    expect(loggedIn.value).toBe(false)
  })

  it('keeps the user on screen when there is no restore provide to ask at all', async () => {
    __test.nuxtApp = { $lukk: {} }
    __test.runtimeConfig.public.lukk = { mode: 'direct', baseURL: '', confirmationHeader: 'X', userEndpoint: '/me', userKey: '' }
    const { initSession, user, loggedIn } = useLukkAuth()
    user.value = { id: 1 }

    await initSession()

    expect(loggedIn.value).toBe(true)
  })

  it('keeps the user on screen when the retry merely could not tell, or was superseded', async () => {
    for (const outcome of [{ pair: null, unavailable: true }, { pair: null, unavailable: false, superseded: true }]) {
      withApp({}, () => Promise.resolve(outcome))
      const { initSession, user, loggedIn, restoreFailed } = useLukkAuth()
      user.value = { id: 1 }

      await initSession()

      expect(loggedIn.value).toBe(true)
      expect(restoreFailed.value).toBe(false)
      __test.reset()
    }
  })

  it('clears it when a retry is answered "no session"', async () => {
    const restore = vi.fn()
      .mockResolvedValueOnce({ pair: null, unavailable: true })
      .mockResolvedValueOnce({ pair: null, unavailable: false })
    withApp({}, restore)
    const { initSession, restoreFailed } = useLukkAuth()

    await initSession()
    expect(restoreFailed.value).toBe(true)
    await initSession()
    expect(restoreFailed.value).toBe(false)
  })

  it('clears it when a retry succeeds on an app with no user endpoint', async () => {
    const restore = vi.fn()
      .mockResolvedValueOnce({ pair: null, unavailable: true })
      .mockResolvedValueOnce({ pair, unavailable: false })
    withApp({}, restore)
    __test.runtimeConfig.public.lukk.userEndpoint = ''
    const { initSession } = useLukkAuth()

    await initSession()
    expect(raw().value).toBe(true)
    await initSession()
    expect(raw().value).toBe(false)
  })

  it('restores with the BFF /refresh shape, which carries no access token', async () => {
    // The BFF strips every credential from the response and answers `{ ok: true, expires_in }`. Mocks
    // shaped like a raw token pair hid that — a restore requiring `access_token` broke every BFF app.
    withApp({}, () => Promise.resolve({ pair: { ok: true, expires_in: 900 } as never, unavailable: false }))
    const { initSession, loggedIn } = useLukkAuth()

    await initSession()

    expect(loggedIn.value).toBe(true)
  })
})

describe('useLukkAuth — a logout during an in-flight restore wins', () => {
  const pair = { access_token: 'a', expires_in: 900 }

  function deferred<T>() {
    let resolve!: (v: T) => void
    const promise = new Promise<T>((r) => { resolve = r })
    return { promise, resolve }
  }

  it('discards a restore result that lands after logout()', async () => {
    const flight = deferred<{ pair: unknown, unavailable: boolean }>()
    withApp({ logout: vi.fn().mockResolvedValue(undefined) }, () => flight.promise)
    const { initSession, logout, loggedIn, restoreFailed } = useLukkAuth()

    const restoring = initSession()
    await logout()
    flight.resolve({ pair: null, unavailable: true })
    await restoring

    expect(restoreFailed.value).toBe(false)
    expect(loggedIn.value).toBe(false)
  })

  it('does not load the user when logout() lands during the refresh', async () => {
    const flight = deferred<{ pair: unknown, unavailable: boolean }>()
    withApp({ logout: vi.fn().mockResolvedValue(undefined) }, () => flight.promise)
    const { initSession, logout, loggedIn } = useLukkAuth()

    const restoring = initSession()
    await logout()
    flight.resolve({ pair, unavailable: false })
    await restoring

    expect(api).not.toHaveBeenCalled()
    expect(loggedIn.value).toBe(false)
  })

  it.each([
    // No 401 row: it writes the `null` logout already wrote, so it could not fail. The case that CAN —
    // a stale 401 landing on a newer session — is pinned in session-generation.test.ts.
    ['a user', () => Promise.resolve({ id: 1, name: 'Ada' })],
    ['a 503', () => Promise.reject({ statusCode: 503 })],
  ])('discards %s from the user endpoint when logout() lands during that load', async (_, answer) => {
    const load = deferred<void>()
    api.mockImplementationOnce(() => load.promise.then(answer))
    withApp({ logout: vi.fn().mockResolvedValue(undefined) }, () => Promise.resolve({ pair, unavailable: false }))
    const { initSession, logout, loggedIn, restoreFailed } = useLukkAuth()

    const restoring = initSession()
    await Promise.resolve()
    await logout()
    load.resolve()
    await restoring

    expect(loggedIn.value).toBe(false)
    expect(restoreFailed.value).toBe(false)
  })
})

describe('useLukkAuth — a stale restore never signs out a NEWER session', () => {
  it('ignores a late 401 from the restore once the user has logged out and back in', async () => {
    // Writing `null` over a user that logout already nulled is invisible, so the stale check looks
    // redundant — until someone signs in again before the old load answers. Then the stale 401 would
    // sign the NEW session out.
    let answer!: (e: unknown) => void
    api.mockImplementationOnce(() => new Promise((_, reject) => { answer = reject }))
    withApp({ logout: vi.fn().mockResolvedValue(undefined) }, () => Promise.resolve({ pair: { access_token: 'a' }, unavailable: false }))
    const { initSession, logout, fetchUser, loggedIn } = useLukkAuth()

    const restoring = initSession()
    await new Promise(resolve => setTimeout(resolve, 0)) // the restore is now waiting on the user load
    await logout()
    await fetchUser() // a new login loads a user
    expect(loggedIn.value).toBe(true)

    answer({ statusCode: 401 }) // the OLD load finally answers
    await restoring

    expect(loggedIn.value).toBe(true)
  })

  it('ignores a late user from the restore once the user has logged out', async () => {
    let answer!: (v: unknown) => void
    api.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve }))
    withApp({ logout: vi.fn().mockResolvedValue(undefined) }, () => Promise.resolve({ pair: { access_token: 'a' }, unavailable: false }))
    const { initSession, logout, loggedIn } = useLukkAuth()

    const restoring = initSession()
    await new Promise(resolve => setTimeout(resolve, 0))
    await logout()
    answer({ id: 7 })
    await restoring

    expect(loggedIn.value).toBe(false)
  })
})

describe('useLukkAuth — robustness of the readiness signal', () => {
  it('reads the restore provide when initSession() runs, not when the composable was created', async () => {
    // A `useLukkAuth()` created before the client plugin provided `$lukkRestore` used to keep
    // `undefined` for good, and its `initSession()` silently never restored.
    __test.nuxtApp = { $lukk: {} }
    __test.runtimeConfig.public.lukk = { mode: 'direct', baseURL: '', confirmationHeader: 'X', userEndpoint: '/me', userKey: '' }
    const { initSession, loggedIn } = useLukkAuth()

    ;(__test.nuxtApp as Record<string, unknown>).$lukkRestore = () => Promise.resolve({ pair: { access_token: 'a' }, unavailable: false })
    await initSession()

    expect(loggedIn.value).toBe(true)
  })

  it('stays ready, and whenReady() resolves, after clearNuxtState() wipes the state', async () => {
    // A common logout idiom. It resets `lukk:ready`, nothing sets it again, and every later
    // `whenReady()` used to hang.
    withApp({})
    restoreState(__test.nuxtApp).restored.value = true
    useState<boolean | undefined>(READY_KEY, () => false).value = undefined // what clearNuxtState() leaves

    const { ready, whenReady } = useLukkAuth()

    expect(ready.value).toBe(true)
    await expect(whenReady()).resolves.toBeUndefined()
  })

  it('warns in development when whenReady() is called before the restore plugin started', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    withApp({})

    void useLukkAuth().whenReady()

    expect(warn).toHaveBeenCalledOnce()
    expect(String(warn.mock.calls[0]![0])).toContain('dependsOn: [\'lukk:session-restore\']')
  })

  it('does not warn once the restore plugin has started', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    withApp({})
    restoreState(__test.nuxtApp).started = true

    void useLukkAuth().whenReady()

    expect(warn).not.toHaveBeenCalled()
  })
})

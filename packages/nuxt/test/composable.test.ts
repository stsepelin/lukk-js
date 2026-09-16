import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { READY_KEY } from '../src/runtime/keys'
import { __test, useState } from './mocks/imports'

// fetchUser goes through useLukkFetch — mock it with a controllable fake.
const { api } = vi.hoisted(() => ({ api: vi.fn() }))
vi.mock('../src/runtime/composables/useLukkFetch', () => ({ useLukkFetch: () => api }))

// eslint-disable-next-line import/first
import { useLukkAuth } from '../src/runtime/composables/useLukkAuth'

type Restore = () => Promise<{ pair: unknown, unavailable: boolean }>
const signedOut: Restore = () => Promise.resolve({ pair: null, unavailable: false })

function withApp(lukk: Record<string, unknown>, lukkRefresh: () => Promise<unknown> = () => Promise.resolve(null), lukkRestore: Restore = signedOut) {
  __test.nuxtApp = { $lukk: lukk, $lukkRefresh: lukkRefresh, $lukkRestore: lukkRestore }
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

  it('fetchUser sets the user to null when the request fails', async () => {
    withApp({})
    api.mockRejectedValueOnce(new Error('401'))
    const { user, fetchUser } = useLukkAuth()
    await fetchUser()
    expect(user.value).toBeNull()
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

  it('initSession restores via the shared single-flight + loads the user when a session exists', async () => {
    const restore = vi.fn().mockResolvedValue({ pair: { access_token: 'a', expires_in: 900 }, unavailable: false })
    withApp({}, undefined, restore)
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
    withApp({}, undefined, () => Promise.resolve({ pair: null, unavailable: true }))
    const { initSession, loggedIn, restoreFailed } = useLukkAuth()

    await initSession()

    // Signed out as far as the UI can tell — but the visitor may have a perfectly valid session.
    expect(loggedIn.value).toBe(false)
    expect(restoreFailed.value).toBe(true)
  })

  it('reports it when the refresh worked but the user endpoint then failed', async () => {
    // The session is VALID here; only loading the user failed. Reporting "signed out" would prompt a
    // signed-in user to log in again.
    withApp({}, undefined, () => Promise.resolve({ pair, unavailable: false }))
    api.mockRejectedValueOnce({ statusCode: 503 })
    const { initSession, loggedIn, restoreFailed } = useLukkAuth()

    await initSession()

    expect(loggedIn.value).toBe(false)
    expect(restoreFailed.value).toBe(true)
  })

  it('does NOT report it when the user endpoint says signed out (401/403)', async () => {
    withApp({}, undefined, () => Promise.resolve({ pair, unavailable: false }))
    api.mockRejectedValueOnce({ statusCode: 401 })
    const { initSession, restoreFailed } = useLukkAuth()

    await initSession()

    expect(restoreFailed.value).toBe(false)
  })

  it('clears it when a retry succeeds', async () => {
    const restore = vi.fn()
      .mockResolvedValueOnce({ pair: null, unavailable: true })
      .mockResolvedValueOnce({ pair, unavailable: false })
    withApp({}, undefined, restore)
    const { initSession, loggedIn, restoreFailed } = useLukkAuth()

    await initSession()
    expect(restoreFailed.value).toBe(true)

    await initSession()
    expect(loggedIn.value).toBe(true)
    expect(restoreFailed.value).toBe(false)
  })

  it('is hidden while someone is signed in, and cleared by logout', async () => {
    withApp({ logout: vi.fn().mockResolvedValue(undefined) }, undefined, () => Promise.resolve({ pair: null, unavailable: true }))
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

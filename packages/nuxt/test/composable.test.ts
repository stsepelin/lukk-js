import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __test } from './mocks/imports'

// fetchUser goes through useLukkFetch — mock it with a controllable fake.
const { api } = vi.hoisted(() => ({ api: vi.fn() }))
vi.mock('../src/runtime/composables/useLukkFetch', () => ({ useLukkFetch: () => api }))

// eslint-disable-next-line import/first
import { useLukkAuth } from '../src/runtime/composables/useLukkAuth'

function withApp(lukk: Record<string, unknown>, lukkRefresh: () => Promise<unknown> = () => Promise.resolve(null)) {
  __test.nuxtApp = { $lukk: lukk, $lukkRefresh: lukkRefresh }
  __test.runtimeConfig.public.lukk = {
    mode: 'direct',
    baseURL: 'https://api/auth',
    confirmationHeader: 'X-Lukk-Confirmation',
    userEndpoint: 'https://app/me',
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
    const refresh = vi.fn().mockResolvedValue({ access_token: 'a', expires_in: 900 })
    withApp({}, refresh)
    const { user, initSession } = useLukkAuth()
    await initSession()
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(user.value).toEqual({ id: 1, name: 'Ada' })
  })

  it('initSession does nothing without a session', async () => {
    withApp({}, vi.fn().mockResolvedValue(null))
    const { user, initSession } = useLukkAuth()
    await initSession()
    expect(user.value).toBeNull()
    expect(api).not.toHaveBeenCalled()
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
})

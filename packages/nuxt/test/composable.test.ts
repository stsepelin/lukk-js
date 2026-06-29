import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useLukkAuth } from '../src/runtime/composables/useLukkAuth'
import { __test, useState } from './mocks/imports'

function withApp(lukk: Record<string, unknown>) {
  __test.nuxtApp = { $lukk: lukk }
  __test.runtimeConfig.public.lukk = {
    mode: 'direct',
    baseURL: 'https://api/auth',
    confirmationHeader: 'X-Lukk-Confirmation',
    userEndpoint: 'https://app/me',
  }
}

const $fetch = () => globalThis as unknown as { $fetch: ReturnType<typeof vi.fn> }

beforeEach(() => { $fetch().$fetch = vi.fn().mockResolvedValue({ id: 1, name: 'Ada' }) })
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
    expect($fetch().$fetch).not.toHaveBeenCalled()
  })

  it('fetchUser attaches a Bearer token when present', async () => {
    withApp({})
    useState<string | null>('lukk:access', () => null).value = 'tok'
    await useLukkAuth().fetchUser()
    expect($fetch().$fetch).toHaveBeenCalledWith('https://app/me', { headers: { Authorization: 'Bearer tok' } })
  })

  it('fetchUser logs out only on auth failures, not transient errors', async () => {
    withApp({})
    const { user, fetchUser } = useLukkAuth()

    await fetchUser()
    expect(user.value).toEqual({ id: 1, name: 'Ada' })

    // transient 5xx → keep the user (don't bounce a logged-in user to /login)
    $fetch().$fetch = vi.fn().mockRejectedValue({ statusCode: 503 })
    await fetchUser()
    expect(user.value).toEqual({ id: 1, name: 'Ada' })

    // 403 → logged out
    $fetch().$fetch = vi.fn().mockRejectedValue({ status: 403 })
    await fetchUser()
    expect(user.value).toBeNull()

    // reload, then 401 → logged out
    $fetch().$fetch = vi.fn().mockResolvedValue({ id: 2, name: 'Bob' })
    await fetchUser()
    expect(user.value).toEqual({ id: 2, name: 'Bob' })
    $fetch().$fetch = vi.fn().mockRejectedValue({ statusCode: 401 })
    await fetchUser()
    expect(user.value).toBeNull()
  })

  it('fetchUser skips when no endpoint is configured', async () => {
    withApp({})
    __test.runtimeConfig.public.lukk.userEndpoint = ''
    const { user, fetchUser } = useLukkAuth()
    await fetchUser()
    expect($fetch().$fetch).not.toHaveBeenCalled()
    expect(user.value).toBeNull()
  })

  it('fetchUser sets the user to null when the request fails', async () => {
    withApp({})
    $fetch().$fetch = vi.fn().mockRejectedValue(new Error('401'))
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

  it('initSession restores + loads the user when a session exists', async () => {
    withApp({ restore: vi.fn().mockResolvedValue({ access_token: 'a', expires_in: 900 }) })
    const { user, initSession } = useLukkAuth()
    await initSession()
    expect(user.value).toEqual({ id: 1, name: 'Ada' })
  })

  it('initSession does nothing without a session', async () => {
    withApp({ restore: vi.fn().mockResolvedValue(null) })
    const { user, initSession } = useLukkAuth()
    await initSession()
    expect(user.value).toBeNull()
    expect($fetch().$fetch).not.toHaveBeenCalled()
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

import { describe, expect, it, vi } from 'vitest'
import { createLukkClient, isTokenPair, type LukkClient } from '../src/client'
import { isTwoFactorChallenge } from '../src/types'

function json(body: unknown, status = 200): Response {
  return new Response(body === undefined ? '' : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('endpoint methods → route + verb', () => {
  const cases: Array<[string, (c: LukkClient) => Promise<unknown>, string, string | undefined]> = [
    ['logout', c => c.logout(), 'https://x/auth/logout', 'POST'],
    ['revokeAllSessions', c => c.revokeAllSessions(), 'https://x/auth/sessions', 'DELETE'],
    ['revokeOtherSessions', c => c.revokeOtherSessions(), 'https://x/auth/sessions/others', 'DELETE'],
    ['confirmPassword', c => c.confirmPassword('p'), 'https://x/auth/confirm-password', 'POST'],
    ['confirmPasskey', c => c.confirmPasskey('cid', { id: 'c' }), 'https://x/auth/confirm-passkey', 'POST'],
    ['twoFactorChallenge', c => c.twoFactorChallenge({ challenge_token: 't', code: '1' }), 'https://x/auth/two-factor-challenge', 'POST'],
    ['refreshTokens(token)', c => c.refreshTokens('rt'), 'https://x/auth/refresh', 'POST'],
    ['refreshTokens()', c => c.refreshTokens(), 'https://x/auth/refresh', 'POST'],
    ['enableTwoFactor', c => c.enableTwoFactor(), 'https://x/auth/two-factor', 'POST'],
    ['confirmTwoFactor', c => c.confirmTwoFactor('123456'), 'https://x/auth/two-factor/confirm', 'POST'],
    ['disableTwoFactor', c => c.disableTwoFactor(), 'https://x/auth/two-factor', 'DELETE'],
    ['recoveryCodeCount', c => c.recoveryCodeCount(), 'https://x/auth/two-factor/recovery-codes', undefined],
    ['regenerateRecoveryCodes', c => c.regenerateRecoveryCodes(), 'https://x/auth/two-factor/recovery-codes', 'POST'],
    ['passkeyRegistrationOptions', c => c.passkeyRegistrationOptions(), 'https://x/auth/passkeys/registration-options', 'POST'],
    ['registerPasskey', c => c.registerPasskey({ id: 'c' }, 'Key'), 'https://x/auth/passkeys', 'POST'],
    ['passkeyLoginOptions', c => c.passkeyLoginOptions(), 'https://x/auth/passkeys/login-options', 'POST'],
    ['loginWithPasskey', c => c.loginWithPasskey('cid', { id: 'c' }), 'https://x/auth/passkeys/login', 'POST'],
    ['listPasskeys', c => c.listPasskeys(), 'https://x/auth/passkeys', undefined],
    ['deletePasskey', c => c.deletePasskey('cred/1'), 'https://x/auth/passkeys/cred%2F1', 'DELETE'],
  ]

  it.each(cases)('%s', async (_name, call, url, method) => {
    const fetch = vi.fn(async () => json({ ok: true }))
    await call(createLukkClient({ baseURL: 'https://x/auth', fetch }))
    const [u, init] = fetch.mock.calls[0]!
    expect(u).toBe(url)
    expect((init as RequestInit | undefined)?.method).toBe(method)
  })
})

describe('request behaviour', () => {
  it('returns undefined for an empty/204 body', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }))
    expect(await createLukkClient({ baseURL: 'https://x/auth', fetch }).logout()).toBeUndefined()
  })

  it('does not override an explicit Content-Type', async () => {
    const fetch = vi.fn(async () => json({ ok: true }))
    await createLukkClient({ baseURL: 'https://x/auth', fetch })
      .request('/x', { method: 'POST', body: 'raw', headers: { 'Content-Type': 'text/plain' } })
    expect(new Headers(fetch.mock.calls[0]![1]!.headers).get('Content-Type')).toBe('text/plain')
  })

  it('ends the session when refresh returns null (onUnauthenticated)', async () => {
    const onUnauthenticated = vi.fn()
    const client = createLukkClient({
      baseURL: 'https://x/auth',
      fetch: vi.fn(async () => json({ message: 'no' }, 401)),
      getAccessToken: () => 'old',
      refresh: async () => null,
      onUnauthenticated,
    })
    await expect(client.request('/protected')).rejects.toMatchObject({ status: 401 })
    expect(onUnauthenticated).toHaveBeenCalledOnce()
  })

  it('throws without retrying when no refresh hook is configured', async () => {
    const fetch = vi.fn(async () => json({ message: 'nope' }, 401))
    const client = createLukkClient({ baseURL: 'https://x/auth', fetch })
    await expect(client.request('/protected')).rejects.toMatchObject({ status: 401, message: 'nope' })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('falls back to statusText on a non-JSON error, with no errors field', async () => {
    const fetch = vi.fn(async () => new Response('oops', { status: 500, statusText: 'Server Error' }))
    await expect(createLukkClient({ baseURL: 'https://x/auth', fetch }).request('/x'))
      .rejects.toEqual({ status: 500, message: 'Server Error' })
  })

  it('refreshes once even when onTokens is not provided', async () => {
    let n = 0
    const fetch = vi.fn(async (url: string) => {
      if (String(url).endsWith('/refresh')) return json({ access_token: 'new', expires_in: 900 })
      return ++n === 1 ? json({ message: 'x' }, 401) : json({ ok: true })
    })
    const client = createLukkClient({ baseURL: 'https://x/auth', fetch, getAccessToken: () => 'old', refresh: () => client.refreshTokens() })
    expect(await client.request('/p')).toEqual({ ok: true })
  })
})

describe('guards', () => {
  it('isTokenPair', () => {
    expect(isTokenPair({ access_token: 'a' })).toBe(true)
    expect(isTokenPair({ two_factor: true })).toBe(false)
    expect(isTokenPair(null)).toBe(false)
    expect(isTokenPair('x')).toBe(false)
  })

  it('isTwoFactorChallenge', () => {
    expect(isTwoFactorChallenge({ two_factor: true, challenge_token: 'c' })).toBe(true)
    expect(isTwoFactorChallenge({ access_token: 'a', expires_in: 1 })).toBe(false)
  })
})

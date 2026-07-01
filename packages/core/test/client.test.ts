import { describe, expect, it, vi } from 'vitest'
import { createLukkClient, lukkError } from '../src/client'

describe('lukkError', () => {
  it('shapes a Laravel error, and falls back to statusText / omits errors without a body', () => {
    expect(lukkError(422, 'X', { message: 'Invalid', errors: { a: ['b'] } })).toEqual({ status: 422, message: 'Invalid', errors: { a: ['b'] } })
    expect(lukkError(500, 'Server Error', undefined)).toEqual({ status: 500, message: 'Server Error' })
    expect(lukkError(401, 'Unauthorized', null)).toEqual({ status: 401, message: 'Unauthorized' })
  })
})

function json(body: unknown, status = 200): Response {
  return new Response(body === undefined ? '' : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('createLukkClient', () => {
  it('logs in and returns a token pair', async () => {
    const fetch = vi.fn(async () => json({ access_token: 'a', expires_in: 900, refresh_token: 'r' }))
    const client = createLukkClient({ baseURL: 'https://x/auth', fetch })

    const result = await client.login({ email: 'e', password: 'p' })

    expect(result).toMatchObject({ access_token: 'a' })
    expect(fetch).toHaveBeenCalledOnce()
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe('https://x/auth/login')
    expect(init?.method).toBe('POST')
  })

  it('passes extra login fields through to the request body (custom authenticateUsing)', async () => {
    const fetch = vi.fn(async () => json({ access_token: 'a', expires_in: 900, refresh_token: 'r' }))
    const client = createLukkClient({ baseURL: 'https://x/auth', fetch })

    // `remember`/`captcha` typecheck without a cast (LoginInput) and reach Laravel.
    await client.login({ email: 'e', password: 'p', remember: true, captcha: 'tok' })

    const body = JSON.parse((fetch.mock.calls[0]![1] as RequestInit).body as string)
    expect(body).toEqual({ email: 'e', password: 'p', remember: true, captcha: 'tok' })
  })

  it('passes extra fields through the 2FA challenge body', async () => {
    const fetch = vi.fn(async () => json({ access_token: 'a', expires_in: 900, refresh_token: 'r' }))
    const client = createLukkClient({ baseURL: 'https://x/auth', fetch })

    await client.twoFactorChallenge({ challenge_token: 'c', code: '123456', device_name: 'phone' })

    const body = JSON.parse((fetch.mock.calls[0]![1] as RequestInit).body as string)
    expect(body).toMatchObject({ challenge_token: 'c', code: '123456', device_name: 'phone' })
  })

  it('returns a 2FA challenge instead of tokens', async () => {
    const fetch = vi.fn(async () => json({ two_factor: true, challenge_token: 'c' }))
    const client = createLukkClient({ baseURL: 'https://x/auth', fetch })

    expect(await client.login({ email: 'e', password: 'p' })).toEqual({ two_factor: true, challenge_token: 'c' })
  })

  it('attaches the Bearer access token and confirmation header', async () => {
    const fetch = vi.fn(async () => json({ ok: true }))
    const client = createLukkClient({
      baseURL: 'https://x/auth',
      fetch,
      getAccessToken: () => 'tok',
      getConfirmationToken: () => 'conf',
    })

    await client.request('/passkeys')

    const headers = new Headers(fetch.mock.calls[0]![1]!.headers)
    expect(headers.get('Authorization')).toBe('Bearer tok')
    expect(headers.get('X-Lukk-Confirmation')).toBe('conf')
  })

  it('refreshes once on 401 and retries the original request', async () => {
    let access = 'old'
    let protectedCalls = 0
    const fetch = vi.fn(async (url: string) => {
      if (String(url).endsWith('/refresh')) return json({ access_token: 'new', expires_in: 900 })
      protectedCalls++
      return protectedCalls === 1 ? json({ message: 'unauth' }, 401) : json({ passkeys: [] })
    })
    const onTokens = vi.fn()
    const client = createLukkClient({
      baseURL: 'https://x/auth',
      fetch,
      getAccessToken: () => access,
      refresh: () => client.refreshTokens().then((p) => { access = p.access_token; return p }),
      onTokens,
    })

    expect(await client.request('/passkeys')).toEqual({ passkeys: [] })
    expect(onTokens).toHaveBeenCalledOnce()
    expect(access).toBe('new')
  })

  it('single-flights concurrent refreshes (one refresh for a burst of 401s)', async () => {
    let refreshCalls = 0
    let firstBatch = true
    const fetch = vi.fn(async (url: string) => {
      if (String(url).endsWith('/refresh')) {
        refreshCalls++
        await new Promise(r => setTimeout(r, 10))
        return json({ access_token: 'new', expires_in: 900 })
      }
      return firstBatch ? json({ message: 'x' }, 401) : json({ ok: true })
    })
    const client = createLukkClient({
      baseURL: 'https://x/auth',
      fetch,
      getAccessToken: () => 'old',
      refresh: () => client.refreshTokens(),
      onTokens: () => { firstBatch = false },
    })

    await Promise.all([client.request('/a'), client.request('/b')])

    expect(refreshCalls).toBe(1)
  })

  it('throws a typed LukkError on a failed request', async () => {
    const fetch = vi.fn(async () => json({ message: 'Nope', errors: { email: ['bad'] } }, 422))
    const client = createLukkClient({ baseURL: 'https://x/auth', fetch })

    await expect(client.login({ email: 'e', password: 'p' }))
      .rejects.toMatchObject({ status: 422, message: 'Nope', errors: { email: ['bad'] } })
  })

  it('persists tokens via onTokens on login, but not on a 2FA challenge', async () => {
    const onTokens = vi.fn()
    const ok = createLukkClient({ baseURL: 'https://x/auth', fetch: vi.fn(async () => json({ access_token: 'a', expires_in: 900 })), onTokens })
    await ok.login({ email: 'e', password: 'p' })
    expect(onTokens).toHaveBeenCalledWith({ access_token: 'a', expires_in: 900 })

    onTokens.mockClear()
    const challenged = createLukkClient({ baseURL: 'https://x/auth', fetch: vi.fn(async () => json({ two_factor: true, challenge_token: 'c' })), onTokens })
    await challenged.login({ email: 'e', password: 'p' })
    expect(onTokens).not.toHaveBeenCalled()
  })

  it('restore() returns the pair on success and null when there is no session', async () => {
    const onTokens = vi.fn()
    const ok = createLukkClient({ baseURL: 'https://x/auth', fetch: vi.fn(async () => json({ access_token: 'a', expires_in: 900 })), onTokens })
    expect(await ok.restore()).toMatchObject({ access_token: 'a' })
    expect(onTokens).toHaveBeenCalledOnce()

    const none = createLukkClient({ baseURL: 'https://x/auth', fetch: vi.fn(async () => json({ message: 'no' }, 401)) })
    expect(await none.restore()).toBeNull()
  })

  it('resolves absolute URLs without prepending the base', async () => {
    const fetch = vi.fn(async () => json({ id: 1 }))
    const client = createLukkClient({ baseURL: 'https://api.example.com/auth', fetch })
    await client.request('https://app.example.com/api/me')
    expect(fetch.mock.calls[0]![0]).toBe('https://app.example.com/api/me')
  })

  it('treats a throwing refresh hook as not-refreshable (→ onUnauthenticated)', async () => {
    const fetch = vi.fn(async () => json({ message: 'unauth' }, 401))
    const onUnauthenticated = vi.fn()
    const client = createLukkClient({
      baseURL: 'https://x/auth',
      fetch,
      getAccessToken: () => 'old',
      refresh: () => Promise.reject(new Error('refresh boom')),
      onUnauthenticated,
    })
    await expect(client.request('/passkeys')).rejects.toBeTruthy()
    expect(onUnauthenticated).toHaveBeenCalledOnce()
  })

  it('throws a typed LukkError when a 2xx body is not valid JSON', async () => {
    const fetch = vi.fn(async () => new Response('<html>nope</html>', { status: 200, headers: { 'content-type': 'text/html' } }))
    const client = createLukkClient({ baseURL: 'https://x/auth', fetch })
    await expect(client.request('/whatever')).rejects.toMatchObject({ status: 200, message: expect.stringContaining('invalid JSON') })
  })

  it('never follows redirects — sends redirect:manual and surfaces a 3xx as an error (no confirmation-token leak)', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }))
    const client = createLukkClient({ baseURL: 'https://x/auth', fetch, getConfirmationToken: () => 'conf' })
    // A step-up call attaches X-Lukk-Confirmation; a 3xx must be surfaced, not chased to `location`.
    await expect(client.confirmPassword('pw')).rejects.toMatchObject({ status: 302 })
    expect((fetch.mock.calls[0]![1] as RequestInit).redirect).toBe('manual')
  })

  describe('credential origin-scoping', () => {
    const headersOf = (fetch: ReturnType<typeof vi.fn>) => new Headers(fetch.mock.calls[0]![1]!.headers)

    it('attaches credentials to a same-origin absolute target', async () => {
      const fetch = vi.fn(async () => json({ ok: true }))
      const client = createLukkClient({ baseURL: 'https://api.example.com/auth', fetch, getAccessToken: () => 'tok', getConfirmationToken: () => 'c' })
      await client.request('https://api.example.com/auth/passkeys')
      expect(headersOf(fetch).get('Authorization')).toBe('Bearer tok')
      expect(headersOf(fetch).get('X-Lukk-Confirmation')).toBe('c')
    })

    it('refuses to attach credentials to a cross-origin absolute target', async () => {
      const fetch = vi.fn(async () => json({ ok: true }))
      const client = createLukkClient({ baseURL: 'https://api.example.com/auth', fetch, getAccessToken: () => 'tok', getConfirmationToken: () => 'c' })
      await client.request('https://evil.com/steal')
      expect(headersOf(fetch).get('Authorization')).toBeNull()
      expect(headersOf(fetch).get('X-Lukk-Confirmation')).toBeNull()
      expect(fetch.mock.calls[0]![1]!.credentials).toBe('same-origin')
    })

    it('refuses credentials when the base is relative and the target is absolute', async () => {
      const fetch = vi.fn(async () => json({ ok: true }))
      const client = createLukkClient({ baseURL: '/api/_lukk', fetch, getAccessToken: () => 'tok' })
      await client.request('https://evil.com/x')
      expect(headersOf(fetch).get('Authorization')).toBeNull()
    })

    it('refuses credentials to a malformed absolute target', async () => {
      const fetch = vi.fn(async () => json({ ok: true }))
      const client = createLukkClient({ baseURL: 'https://api.example.com/auth', fetch, getAccessToken: () => 'tok' })
      await client.request('https://bad host/x')
      expect(headersOf(fetch).get('Authorization')).toBeNull()
    })
  })
})

import { describe, expect, it, vi } from 'vitest'
import { carriesOrigin, createLukkClient, isSameOrigin, lukkError } from '../src/client'

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

  it('logs in by a username identifier (configurable lukk.username)', async () => {
    const fetch = vi.fn(async () => json({ access_token: 'a', expires_in: 900, refresh_token: 'r' }))
    const client = createLukkClient({ baseURL: 'https://x/auth', fetch })

    await client.login({ username: 'ada', password: 'p' }) // typechecks without `email`

    expect(JSON.parse((fetch.mock.calls[0]![1] as RequestInit).body as string)).toEqual({ username: 'ada', password: 'p' })
  })

  it('registers and returns (and persists) a token pair', async () => {
    const onTokens = vi.fn()
    const fetch = vi.fn(async () => json({ access_token: 'a', expires_in: 900, refresh_token: 'r' }))
    const client = createLukkClient({ baseURL: 'https://x/auth', fetch, onTokens })

    const result = await client.register({ email: 'e', password: 'p', password_confirmation: 'p' })

    expect(result).toMatchObject({ access_token: 'a' })
    expect(onTokens).toHaveBeenCalledOnce() // committed, like login
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe('https://x/auth/register')
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ email: 'e', password: 'p', password_confirmation: 'p' })
  })

  it('register surfaces a 2FA challenge (not persisted)', async () => {
    const onTokens = vi.fn()
    const fetch = vi.fn(async () => json({ two_factor: true, challenge_token: 'c' }))
    const client = createLukkClient({ baseURL: 'https://x/auth', fetch, onTokens })

    expect(await client.register({ email: 'e', password: 'p', password_confirmation: 'p' }))
      .toEqual({ two_factor: true, challenge_token: 'c' })
    expect(onTokens).not.toHaveBeenCalled()
  })

  it('register surfaces a verify-first pending shape (not persisted)', async () => {
    const onTokens = vi.fn()
    const fetch = vi.fn(async () => json({ registered: true, requires_verification: true }, 201))
    const client = createLukkClient({ baseURL: 'https://x/auth', fetch, onTokens })

    expect(await client.register({ email: 'e', password: 'p', password_confirmation: 'p' }))
      .toEqual({ registered: true, requires_verification: true })
    expect(onTokens).not.toHaveBeenCalled()
  })

  it('resends the email-verification link', async () => {
    const fetch = vi.fn(async () => json({ status: 'verification-link-sent' }, 202))
    const client = createLukkClient({ baseURL: 'https://x/auth', fetch })

    await client.sendEmailVerification()

    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe('https://x/auth/email/verification-notification')
    expect(init?.method).toBe('POST')
  })

  it('requests a password-reset link (forgot-password)', async () => {
    const fetch = vi.fn(async () => json({ status: 'password-reset-link-sent' }))
    const client = createLukkClient({ baseURL: 'https://x/auth', fetch })

    await client.forgotPassword('a@b.c')

    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe('https://x/auth/forgot-password')
    expect(init?.method).toBe('POST')
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ email: 'a@b.c' })
  })

  it('changes the signed-in password, sending the current one as the proof', async () => {
    // No emailed token here — `current_password` IS the proof, which is what stops a stolen access
    // token from being enough to take the account over.
    const fetch = vi.fn(async () => json({ status: 'password-changed' }))
    const client = createLukkClient({ baseURL: 'https://x/auth', fetch, getAccessToken: () => 'AT' })
    const body = { current_password: 'old', password: 'new-secret-123', password_confirmation: 'new-secret-123' }

    await client.changePassword(body)

    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe('https://x/auth/password')
    expect(init?.method).toBe('POST')
    expect(JSON.parse((init as RequestInit).body as string)).toEqual(body)
    // Same-origin as the base, so the bearer rides along — the endpoint is authenticated.
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer AT')
  })

  it('completes a password reset with the token + email + new password', async () => {
    const fetch = vi.fn(async () => json({ status: 'password-reset' }))
    const client = createLukkClient({ baseURL: 'https://x/auth', fetch })

    await client.resetPassword({ token: 't', email: 'a@b.c', password: 'new-secret-123', password_confirmation: 'new-secret-123' })

    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe('https://x/auth/reset-password')
    expect(init?.method).toBe('POST')
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ token: 't', email: 'a@b.c', password: 'new-secret-123', password_confirmation: 'new-secret-123' })
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

  it.each([
    ['login', (c: ReturnType<typeof createLukkClient>) => c.login({ email: 'e', password: 'p' })],
    ['register', (c: ReturnType<typeof createLukkClient>) => c.register({ email: 'e', password: 'p', password_confirmation: 'p' })],
    ['twoFactorChallenge', (c: ReturnType<typeof createLukkClient>) => c.twoFactorChallenge({ challenge_token: 't', code: '123456' })],
    ['loginWithPasskey', (c: ReturnType<typeof createLukkClient>) => c.loginWithPasskey('cid', { id: 'c' })],
  ])('%s never refreshes on a 401 — it rejects with it', async (_, signIn) => {
    // A sign-in doesn't use the current session, so its 401 is the answer (an unknown passkey), not an
    // expired token. Refreshing would rotate the refresh token of the session being replaced.
    const fetch = vi.fn(async () => json({ message: 'Unauthenticated.' }, 401))
    const refresh = vi.fn(async () => ({ access_token: 'new', expires_in: 900 }))
    const onUnauthenticated = vi.fn()
    const client = createLukkClient({ baseURL: 'https://x/auth', fetch, refresh, onUnauthenticated })

    await expect(signIn(client)).rejects.toMatchObject({ status: 401 })

    expect(refresh).not.toHaveBeenCalled()
    expect(onUnauthenticated).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('logout refreshes and retries on a 401 by default, and not when asked not to', async () => {
    const calls: string[] = []
    let refreshed = false
    const fetch = vi.fn(async (url: string) => {
      calls.push(String(url).replace('https://x/auth', ''))
      if (String(url).endsWith('/refresh')) return json({ access_token: 'new', expires_in: 900 })
      return refreshed ? json({}) : json({ message: 'Unauthenticated.' }, 401)
    })
    const refresh = vi.fn(async () => { refreshed = true; return { access_token: 'new', expires_in: 900 } })
    const client = createLukkClient({ baseURL: 'https://x/auth', fetch, refresh })

    await client.logout()
    expect(refresh).toHaveBeenCalledOnce()
    expect(calls).toEqual(['/logout', '/logout'])

    refreshed = false
    refresh.mockClear()
    calls.length = 0
    await expect(client.logout({ retry: false })).rejects.toMatchObject({ status: 401 })
    expect(refresh).not.toHaveBeenCalled()
    expect(calls).toEqual(['/logout'])
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

describe('isSameOrigin canonicalises before deciding', () => {
  const base = 'https://api.example.com/auth'

  it('refuses every URL the WHATWG parser resolves to a foreign origin', () => {
    // A bare `^https?://` test is far stricter than the parser, which strips leading C0 controls
    // and spaces and treats `\` as `/` for special schemes. Each of these resolved to
    // https://evil.com while reading as "relative" — and relative is what gets credentials.
    for (const path of [
      'https:/\\evil.com/steal',
      ' https://evil.com/steal',
      '\thttps://evil.com/steal',
      '\nhttps://evil.com/steal',
      'HTTPS:\\\\evil.com/steal',
      '//evil.com/steal',
      '/\\evil.com/steal',
    ])
      expect(isSameOrigin(base, path), path).toBe(false)
  })

  it('refuses a URL whose scheme is split by a tab, LF or CR — the parser removes them from ANYWHERE', () => {
    // The leading-only strip missed this: the URL parser removes ASCII tab, LF and CR from any
    // position, so each of these resolves to a foreign origin while reading as a relative path. Proven
    // end to end against real ofetch, which leaves the string unjoined (ufo's `hasProtocol` matches
    // `\s` inside the scheme) and hands it to `fetch`, where the platform resolves it.
    const TAB = String.fromCharCode(9), LF = String.fromCharCode(10), CR = String.fromCharCode(13)

    for (const path of [
      `ht${TAB}tps://evil.com/steal`,
      `htt${LF}p://evil.com/steal`,
      `h${CR}ttps://evil.com/steal`,
      `https${TAB}://evil.com/steal`,
      `/${TAB}/evil.com/steal`,
      `//evil${LF}.com/steal`,
    ]) {
      expect(isSameOrigin(base, path), JSON.stringify(path)).toBe(false)
      // And the platform really does resolve them somewhere else — the reason this matters.
      expect(new URL(path, 'https://api.example.com/').origin, JSON.stringify(path)).not.toBe('https://api.example.com')
    }
  })

  it('reports carriesOrigin for the same split-scheme shapes', () => {
    const TAB = String.fromCharCode(9)
    expect(carriesOrigin(`ht${TAB}tps://evil.com`)).toBe(true)
    expect(carriesOrigin(`/${TAB}/evil.com`)).toBe(true)
    expect(carriesOrigin('/still/relative')).toBe(false)
  })

  it('refuses a non-http scheme whatever the base', () => {
    expect(isSameOrigin(base, 'javascript:alert(1)')).toBe(false)
    expect(isSameOrigin(base, 'data:text/html,x')).toBe(false)
  })

  it('still accepts genuinely relative paths and a same-origin absolute URL', () => {
    expect(isSameOrigin(base, '/login')).toBe(true)
    expect(isSameOrigin(base, 'login')).toBe(true)
    expect(isSameOrigin(base, 'https://api.example.com/x')).toBe(true)
    // :443 is https's default port, so the origins match.
    expect(isSameOrigin(base, 'https://api.example.com:443/x')).toBe(true)
  })

  it('still refuses a genuinely different origin', () => {
    expect(isSameOrigin(base, 'https://evil.com/steal')).toBe(false)
    expect(isSameOrigin(base, 'https://api.example.com:8443/x')).toBe(false)
  })
})

describe('joinURL cannot emit an authority', () => {
  it('strips every leading slash, so an empty base cannot produce a protocol-relative URL', async () => {
    // With base '' or '/', stripping only ONE slash left `//evil.com/x` — a foreign origin that
    // isSameOrigin had already blessed as relative.
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }))

    for (const base of ['', '/']) {
      const client = createLukkClient({ baseURL: base, fetch: fetchSpy as never })
      await client.request('//evil.test/steal').catch(() => {})
    }

    for (const call of fetchSpy.mock.calls)
      expect(String(call[0]).startsWith('//')).toBe(false)
  })
})

describe('URL guards, mutation-pinned', () => {
  const base = 'https://api.example.com/auth'

  /** The URL that reaches `fetch` for a given base + path — `joinURL` is private. */
  async function fetched(baseURL: string, path: string): Promise<string> {
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }))
    const client = createLukkClient({ baseURL, fetch: fetchSpy as never })
    await client.request(path).catch(() => {})

    return String(fetchSpy.mock.calls[0]![0])
  }

  it('anchors the absolute-URL test, so a scheme in the MIDDLE of a path is still a path', async () => {
    // Unanchored, `orders/https://x` reads as absolute and is returned UNJOINED — the caller then
    // fetches it against the document instead of against the API.
    expect(await fetched('https://api.example.com', 'orders/https://evil.com'))
      .toBe('https://api.example.com/orders/https://evil.com')
    // A genuinely absolute path still passes through, http as well as https, case-insensitively.
    expect(await fetched('https://api.example.com', 'https://api.example.com/x')).toBe('https://api.example.com/x')
    expect(await fetched('https://api.example.com', 'HTTP://other.example/x')).toBe('HTTP://other.example/x')
  })

  it('strips leading slashes ANYWHERE in the run, not just the first', async () => {
    // One `/` left behind on an empty base is `//evil.com` — an authority, not a path.
    expect(await fetched('', '//evil.com/x')).toBe('/evil.com/x')
    expect(await fetched('https://api.example.com/', '/me')).toBe('https://api.example.com/me')
  })

  it('anchors the canonicalisation at the START of the string', () => {
    // Unanchored, the C0 strip would also eat spaces between path segments; un-quantified it would
    // remove only one of a run and leave the rest to shift the scheme.
    const SP = String.fromCharCode(32), NUL = String.fromCharCode(1)
    expect(isSameOrigin(base, `${NUL}${SP}${NUL}https://evil.com/x`)).toBe(false)
    expect(isSameOrigin(base, `/a${SP}b`)).toBe(true) // an inner space is part of the path, not stripped
  })

  it('refuses a protocol-relative URL by its START, not its end', () => {
    // `endsWith('//')` is the mutation this kills, and it reads every `//evil.com` as relative.
    expect(carriesOrigin('//evil.com/x')).toBe(true)
    expect(isSameOrigin(base, '//evil.com/x')).toBe(false)
    // A path ENDING in `//` is not an authority and must stay relative.
    expect(carriesOrigin('/orders//')).toBe(false)
    expect(isSameOrigin(base, '/orders//')).toBe(true)
  })

  it('anchors the scheme test, so a colon later in the path is not a scheme', () => {
    expect(carriesOrigin('orders/a:b')).toBe(false)
    expect(carriesOrigin('a:b')).toBe(true)
  })

  it('requires BOTH sides to be http(s) — either one alone is not enough', () => {
    // `||` → `&&` lets a non-http candidate through whenever the base is absolute.
    expect(isSameOrigin(base, 'ftp://api.example.com/x')).toBe(false)
    expect(isSameOrigin('/relative-base', 'https://api.example.com/x')).toBe(false)
    // And https must not be read as the only acceptable scheme.
    expect(isSameOrigin('http://api.example.com', 'http://api.example.com/x')).toBe(true)
  })
})

describe('request() headers and credentials, mutation-pinned', () => {
  const ok = () => json({ ok: true })

  it('sets Accept exactly, and Content-Type only for a body that has none', async () => {
    const fetch = vi.fn(async () => ok())
    const client = createLukkClient({ baseURL: 'https://x/auth', fetch })

    await client.request('/me') // no body
    let headers = new Headers((fetch.mock.calls[0]![1] as RequestInit).headers)
    expect(headers.get('accept')).toBe('application/json')
    // Setting it unconditionally would declare a body on a GET that has none.
    expect(headers.has('content-type')).toBe(false)

    // A caller's own Content-Type is left alone — the guard is `!headers.has(...)`.
    await client.request('/upload', { body: 'raw', headers: { 'Content-Type': 'text/csv' } })
    headers = new Headers((fetch.mock.calls[1]![1] as RequestInit).headers)
    expect(headers.get('content-type')).toBe('text/csv')
  })

  it('omits Authorization and the confirmation header when the hooks return nothing', async () => {
    // Attaching unconditionally sends the literal `Bearer undefined`, which a server logs as a
    // credential and which is indistinguishable from a real attempt in a rate-limit bucket.
    const fetch = vi.fn(async () => ok())
    const client = createLukkClient({
      baseURL: 'https://x/auth',
      fetch,
      getAccessToken: () => null,
      getConfirmationToken: () => null,
    })

    await client.request('/me')

    const headers = new Headers((fetch.mock.calls[0]![1] as RequestInit).headers)
    expect(headers.has('authorization')).toBe(false)
    expect(headers.has('x-lukk-confirmation')).toBe(false)
  })

  it('names the credentials mode exactly, both ways', async () => {
    // An empty string is not a valid RequestCredentials value; the platform falls back to `same-origin`
    // for a same-origin target (invisible) and drops cookies for the cross-origin one (also invisible
    // in a mock). Assert the literal.
    const fetch = vi.fn(async () => ok())
    const client = createLukkClient({ baseURL: 'https://x/auth', fetch })

    await client.request('/me')
    expect((fetch.mock.calls[0]![1] as RequestInit).credentials).toBe('include')

    await client.request('https://evil.example/steal')
    expect((fetch.mock.calls[1]![1] as RequestInit).credentials).toBe('same-origin')
  })

  it('refreshes only on a 401, and retries exactly once', async () => {
    // `allowRetry` is what stops a server answering 401 forever from looping: the retry passes
    // `false`, so the second 401 surfaces instead of refreshing again.
    const refresh = vi.fn(async () => ({ access_token: 'new', expires_in: 900, refresh_token: 'r2' }))
    const fetch = vi.fn(async () => json({ message: 'nope' }, 401))
    const client = createLukkClient({ baseURL: 'https://x/auth', fetch, refresh })

    await expect(client.request('/me')).rejects.toMatchObject({ status: 401 })

    expect(refresh).toHaveBeenCalledOnce()
    expect(fetch).toHaveBeenCalledTimes(2) // original + one retry, never a third

    // A 200 refreshes nothing at all.
    refresh.mockClear()
    const fine = vi.fn(async () => ok())
    await createLukkClient({ baseURL: 'https://x/auth', fetch: fine, refresh }).request('/me')
    expect(refresh).not.toHaveBeenCalled()
  })

  it('retries with the refreshed token and returns the retry\'s body', async () => {
    // Pins that the refresh actually produced a usable pair and the retry happened — a `refresh` that
    // silently returned nothing would fall through to `onUnauthenticated` instead.
    const refresh = vi.fn(async () => ({ access_token: 'new', expires_in: 900, refresh_token: 'r2' }))
    const onTokens = vi.fn()
    let calls = 0
    const fetch = vi.fn(async () => (++calls === 1 ? json({ message: 'stale' }, 401) : json({ me: 'ada' })))
    const client = createLukkClient({ baseURL: 'https://x/auth', fetch, refresh, onTokens })

    expect(await client.request('/me')).toEqual({ me: 'ada' })
    expect(onTokens).toHaveBeenCalledWith(expect.objectContaining({ access_token: 'new' }))
  })

  it('does not require an onUnauthenticated hook to exist', async () => {
    // The `?.()` is load-bearing: a binding that supplies no hook would otherwise throw a TypeError
    // out of `request`, replacing a clean 401 with a crash.
    const fetch = vi.fn(async () => json({ message: 'nope' }, 401))
    const client = createLukkClient({ baseURL: 'https://x/auth', fetch, refresh: async () => null })

    await expect(client.request('/me')).rejects.toMatchObject({ status: 401 })
  })
})

describe('the remaining client.ts guards, mutation-pinned', () => {
  const ok = () => json({ ok: true })
  const base = 'https://api.example.com/auth'

  it('refuses a blob: URL that names the API\'s own origin', () => {
    // `new URL('blob:https://api.example.com/uuid').origin` IS `https://api.example.com` — so without
    // the explicit http(s) test, an origin comparison alone blesses it and attaches the bearer. The
    // scheme check is what makes `blob:`, `javascript:` and `data:` unreachable, whatever the base.
    expect(isSameOrigin(base, 'blob:https://api.example.com/uuid')).toBe(false)
    expect(isSameOrigin(base, 'javascript:alert(1)')).toBe(false)
  })

  it('anchors the C0 strip at the start, so an inner space stays part of the path', () => {
    // Unanchored, `replace` eats the FIRST run anywhere: `x https://evil.com` becomes
    // `xhttps://evil.com`, which then reads as a scheme and is refused — a relative path
    // misclassified. The parser only strips leading/trailing C0-or-space.
    expect(isSameOrigin(base, 'x https://evil.com')).toBe(true)
  })

  it('releases the single-flight slot, so a later refresh is a new call', async () => {
    // The `.finally` that clears `inflight` is what makes it single-FLIGHT rather than single-SHOT:
    // without it the first promise is memoised forever and every later refresh returns a token that
    // has already been rotated away.
    const refresh = vi.fn(async () => ({ access_token: 'a', expires_in: 900, refresh_token: 'r' }))
    let calls = 0
    const fetch = vi.fn(async () => (++calls % 2 === 1 ? json({ message: 'stale' }, 401) : ok()))
    const client = createLukkClient({ baseURL: base, fetch, refresh })

    await client.request('/one')
    await client.request('/two')

    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('treats a non-object refresh result as "not refreshable" instead of throwing', async () => {
    // `isTokenPair` guards the `in` operator: `'access_token' in 'a-string'` is a TypeError, so a
    // hook returning a bare string would crash `request` rather than degrading to unauthenticated.
    const onUnauthenticated = vi.fn()
    const fetch = vi.fn(async () => json({ message: 'nope' }, 401))
    const client = createLukkClient({
      baseURL: base,
      fetch,
      refresh: (async () => 'not-a-pair') as never,
      onUnauthenticated,
    })

    await expect(client.request('/me')).rejects.toMatchObject({ status: 401 })
    expect(onUnauthenticated).toHaveBeenCalledOnce()
  })

  it('never lets a 401 from /refresh itself start another refresh', async () => {
    // `restore()` and `refreshTokens()` pass `allowRetry: false`, because the thing that would be
    // retried IS the refresh: allowing it turns one dead session into an endless pair of calls.
    const refresh = vi.fn(async () => ({ access_token: 'a', expires_in: 900, refresh_token: 'r' }))
    const fetch = vi.fn(async () => json({ message: 'nope' }, 401))
    const client = createLukkClient({ baseURL: base, fetch, refresh })

    // `restore()` swallows the failure by design — "no session" is its documented answer.
    expect(await client.restore()).toBeNull()
    await expect(client.refreshTokens('rt')).rejects.toMatchObject({ status: 401 })

    expect(refresh).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledTimes(2) // one each, no retry
  })

  it('posts each credential-bearing body under the right path', async () => {
    // The bodies themselves: replacing any of these with `{}` sends a well-formed request that simply
    // omits the credential, which every status-only assertion still accepts.
    const fetch = vi.fn(async () => ok())
    const client = createLukkClient({ baseURL: base, fetch })
    const sent = (i: number) => ({
      url: String(fetch.mock.calls[i]![0]),
      body: JSON.parse((fetch.mock.calls[i]![1] as RequestInit).body as string),
    })

    await client.confirmPassword('hunter2')
    await client.confirmPasskey('cid', { id: 'c1' })
    await client.confirmTwoFactor('123456')
    await client.registerPasskey({ id: 'c2' }, 'My Key')
    await client.loginWithPasskey('cid2', { id: 'c3' })
    await client.refreshTokens('rt-1')

    expect(sent(0)).toEqual({ url: `${base}/confirm-password`, body: { password: 'hunter2' } })
    expect(sent(1)).toEqual({ url: `${base}/confirm-passkey`, body: { ceremony_id: 'cid', credential: { id: 'c1' } } })
    expect(sent(2)).toEqual({ url: `${base}/two-factor/confirm`, body: { code: '123456' } })
    expect(sent(3)).toEqual({ url: `${base}/passkeys`, body: { credential: { id: 'c2' }, name: 'My Key' } })
    expect(sent(4)).toEqual({ url: `${base}/passkeys/login`, body: { ceremony_id: 'cid2', credential: { id: 'c3' } } })
    expect(sent(5)).toEqual({ url: `${base}/refresh`, body: { refresh_token: 'rt-1' } })
  })

  it('logs out at /logout, retrying by default and not when told otherwise', async () => {
    const refresh = vi.fn(async () => ({ access_token: 'a', expires_in: 900, refresh_token: 'r' }))
    const fetch = vi.fn(async () => json({ message: 'nope' }, 401))
    const client = createLukkClient({ baseURL: base, fetch, refresh })

    await expect(client.logout()).rejects.toMatchObject({ status: 401 })
    expect(String(fetch.mock.calls[0]![0])).toBe(`${base}/logout`)
    expect(refresh).toHaveBeenCalledOnce() // the default retries

    refresh.mockClear()
    fetch.mockClear()
    await expect(client.logout({ retry: false })).rejects.toMatchObject({ status: 401 })
    expect(refresh).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledOnce()
  })
})

describe('the last client.ts guards', () => {
  const base = 'https://api.example.com/auth'

  it('accepts only a plain object as a token pair, not any value carrying access_token', async () => {
    // `refresh` is a consumer hook: it can return anything. The object test is what stops a non-object
    // that happens to expose `access_token` — a function with a property, a class instance built from
    // an attacker-shaped body — reaching `onTokens` and being persisted as a session.
    const carrier = Object.assign(() => {}, { access_token: 'tok', expires_in: 900, refresh_token: 'r' })
    const onTokens = vi.fn()
    const onUnauthenticated = vi.fn()
    const fetch = vi.fn(async () => json({ message: 'nope' }, 401))
    const client = createLukkClient({
      baseURL: base,
      fetch,
      refresh: (async () => carrier) as never,
      onTokens,
      onUnauthenticated,
    })

    await expect(client.request('/me')).rejects.toMatchObject({ status: 401 })
    expect(onTokens).not.toHaveBeenCalled()
    expect(onUnauthenticated).toHaveBeenCalledOnce()
  })

  it('restores from /refresh, not from wherever an empty path lands', async () => {
    const fetch = vi.fn(async () => json({ access_token: 'a', expires_in: 900, refresh_token: 'r' }))
    const client = createLukkClient({ baseURL: base, fetch })

    await client.restore()

    expect(String(fetch.mock.calls[0]![0])).toBe(`${base}/refresh`)
  })

  it('re-sends the logout without keepalive when the browser refuses it, keeping path and retry', async () => {
    // A browser that refuses a keepalive request needing a CORS preflight rejects with a TypeError.
    // The fallback is the only thing standing between that and a logout that never reaches lukk —
    // and it has to go to the same path, with the same retry decision, or it is not the same logout.
    const refresh = vi.fn(async () => ({ access_token: 'a', expires_in: 900, refresh_token: 'r' }))
    let call = 0
    const fetch = vi.fn(async () => {
      if (++call === 1) throw new TypeError('keepalive refused')
      return json({ message: 'nope' }, 401)
    })
    const client = createLukkClient({ baseURL: base, fetch, refresh })

    await expect(client.logout()).rejects.toMatchObject({ status: 401 })

    expect(String(fetch.mock.calls[1]![0])).toBe(`${base}/logout`)
    expect((fetch.mock.calls[1]![1] as RequestInit & { keepalive?: boolean }).keepalive).toBeUndefined()
    expect(refresh).toHaveBeenCalledOnce() // the fallback still retries by default

    // And `retry: false` is honoured on the fallback too.
    refresh.mockClear()
    call = 0
    await expect(client.logout({ retry: false })).rejects.toMatchObject({ status: 401 })
    expect(refresh).not.toHaveBeenCalled()
  })
})

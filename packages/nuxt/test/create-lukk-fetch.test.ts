import type { $Fetch, FetchOptions } from 'ofetch'
import { describe, expect, it, vi } from 'vitest'
import { createLukkFetch, createRequestFetch, type LukkFetchDeps } from '../src/runtime/utils/create-lukk-fetch'

interface FakeResponse { status: number, type?: string, statusText?: string, headers: Headers, _data?: unknown }
interface CreatedOpts {
  baseURL: string
  credentials: string
  redirect: string
  retry: number
  retryStatusCodes: number[]
  onRequest: (ctx: { request: string, options: { headers: Headers, credentials?: string } }) => void | Promise<void>
  onResponse: (ctx: { response: FakeResponse }) => void | Promise<void>
  onResponseError: (ctx: { response: FakeResponse, options: { retry: unknown } }) => Promise<void>
}

// Capture the options `createLukkFetch` hands to ofetch, then drive the interceptors
// directly with fabricated contexts — the retry loop itself is ofetch's job.
function build(overrides: Partial<LukkFetchDeps> = {}) {
  let opts = {} as CreatedOpts
  const fetchImpl = { create: (o: unknown) => { opts = o as CreatedOpts; return () => Promise.resolve() } } as unknown as $Fetch
  const deps: LukkFetchDeps = {
    baseURL: '/api',
    isServer: false,
    canRefresh: false,
    getCookieHeader: () => undefined,
    getBearer: () => null,
    refresh: vi.fn(async () => ({ access_token: 'new' })),
    onRedirect: vi.fn(),
    fetchImpl,
    ...overrides,
  }
  createLukkFetch(deps)
  return { opts, deps }
}

const reqCtx = (request = '/me') => ({ request, options: { headers: new Headers() } as { headers: Headers, credentials?: string } })

describe('createLukkFetch — instance options', () => {
  it('sets baseURL, a fail-closed credentials default, manual redirect', () => {
    const { opts } = build({ baseURL: 'https://api.example.com' })
    expect(opts.baseURL).toBe('https://api.example.com')
    // `same-origin` at the instance level, upgraded per request by the hook below: a caller's own
    // `onRequest` REPLACES ours (ofetch merges options by spreading), and `include` as the default would
    // then ride a cross-origin URL with that origin's cookies.
    expect(opts.credentials).toBe('same-origin')
    expect(opts.redirect).toBe('manual')
    expect(opts.retryStatusCodes).toEqual([401])
  })

  it('enables one retry only when refresh is possible (direct)', () => {
    expect(build({ canRefresh: true }).opts.retry).toBe(1)
    expect(build({ canRefresh: false }).opts.retry).toBe(0)
  })
})

describe('createLukkFetch — onRequest headers', () => {
  it('always forces Accept: application/json', async () => {
    const { opts } = build()
    const ctx = reqCtx()
    await opts.onRequest(ctx)
    expect(ctx.options.headers.get('accept')).toBe('application/json')
  })

  it('forwards ONLY the cookie in SSR (never bearer)', async () => {
    const { opts } = build({ isServer: true, getCookieHeader: () => 'lukk=sealed', getBearer: () => null })
    const ctx = reqCtx()
    await opts.onRequest(ctx)
    expect(ctx.options.headers.get('cookie')).toBe('lukk=sealed')
    expect(ctx.options.headers.get('authorization')).toBeNull()
  })

  it('does not set a cookie header in SSR when there is none', async () => {
    const { opts } = build({ isServer: true, getCookieHeader: () => undefined })
    const ctx = reqCtx()
    await opts.onRequest(ctx)
    expect(ctx.options.headers.has('cookie')).toBe(false)
  })

  it('attaches the bearer (direct) and never forwards a cookie on the client', async () => {
    const { opts } = build({ isServer: false, getBearer: () => 'tok', getCookieHeader: () => 'x=1' })
    const ctx = reqCtx()
    await opts.onRequest(ctx)
    expect(ctx.options.headers.get('authorization')).toBe('Bearer tok')
    expect(ctx.options.headers.has('cookie')).toBe(false)
  })

  it('sets credentials: include for a same-origin (relative) request', async () => {
    const { opts } = build()
    const ctx = reqCtx('/me')
    await opts.onRequest(ctx)
    expect(ctx.options.credentials).toBe('include')
  })

  it('still attaches them for a same-origin per-call baseURL', async () => {
    const { opts } = build({ baseURL: 'https://api.example.com', getBearer: () => 'SECRET' })
    const ctx = { request: '/me', options: { headers: new Headers(), baseURL: 'https://api.example.com/v2' } as { headers: Headers, credentials?: string, baseURL?: string } }

    await opts.onRequest(ctx)

    expect(ctx.options.headers.get('authorization')).toBe('Bearer SECRET')
    expect(ctx.options.credentials).toBe('include')
  })

  it('accepts a relative per-call baseURL when the API is same-origin with the app (the BFF mount)', async () => {
    const { opts } = build({ baseURL: '/api', getBearer: () => 'SECRET' })
    const ctx = { request: '/me', options: { headers: new Headers(), baseURL: '/api/v2' } as { headers: Headers, credentials?: string, baseURL?: string } }

    await opts.onRequest(ctx)

    expect(ctx.options.credentials).toBe('include')
  })

  it('accepts an ABSOLUTE per-call baseURL (or URL) on this app\'s own origin — the BFF mount spelled out', async () => {
    // `isSameOrigin` refuses every absolute URL against the relative `/api` mount, so without the app's
    // own origin to compare against, `useLukkFetch('https://app.test/api/me')` would silently lose its
    // bearer. Both the request and the per-call base are judged this way.
    const { opts } = build({ baseURL: '/api', origin: 'https://app.test', getBearer: () => 'SECRET' })

    const absolute = { request: 'https://app.test/api/me', options: { headers: new Headers() } as { headers: Headers, credentials?: string } }
    await opts.onRequest(absolute)
    expect(absolute.options.headers.get('authorization')).toBe('Bearer SECRET')
    expect(absolute.options.credentials).toBe('include')

    const base = { request: '/me', options: { headers: new Headers(), baseURL: 'https://app.test/api' } as { headers: Headers, credentials?: string, baseURL?: string } }
    await opts.onRequest(base)
    expect(base.options.credentials).toBe('include')

    // Another origin is still refused, however this app names itself.
    const elsewhere = { request: '/me', options: { headers: new Headers(), baseURL: 'https://collector.example' } as { headers: Headers, credentials?: string, baseURL?: string } }
    await opts.onRequest(elsewhere)
    expect(elsewhere.options.headers.get('authorization')).toBeNull()
    expect(elsewhere.options.credentials).toBe('same-origin')
  })

  it('does NOT stand this app\'s origin in for the API\'s when the API base is absolute', async () => {
    // The fallback exists because `isSameOrigin` refuses every absolute URL against the relative proxy
    // mount. With an absolute API base there is no such problem and the app's origin is simply a
    // different host — one the bearer was never scoped to, and which on the server is read from the
    // `Host` header. Attaching there would hand the API credential to the app's own endpoints.
    const { opts } = build({ baseURL: 'https://api.example.com', origin: 'https://app.test', isServer: true, getCookieHeader: () => 'lukk=sealed', getBearer: () => 'SECRET' })

    const ctx = { request: 'https://app.test/track', options: { headers: new Headers() } as { headers: Headers, credentials?: string } }
    await opts.onRequest(ctx)

    expect(ctx.options.headers.get('authorization')).toBeNull()
    expect(ctx.options.headers.get('cookie')).toBeNull()
    expect(ctx.options.credentials).toBe('same-origin')
  })

  it('treats an EMPTY per-call baseURL as absent — it means "this path, as given"', async () => {
    // `loadUser` passes `{ baseURL: '' }` so a configured absolute `user.endpoint` is left alone. Read as
    // a relative base it was refused against an absolute API base, so every ordinary direct-mode app
    // signed in and then never loaded its user: no bearer, 401, a refresh rotation burnt per retry.
    const { opts } = build({ baseURL: 'https://api.example.com', getBearer: () => 'SECRET' })
    const ctx = { request: 'https://api.example.com/api/me', options: { headers: new Headers(), baseURL: '' } as { headers: Headers, credentials?: string, baseURL?: string } }

    await opts.onRequest(ctx)

    expect(ctx.options.headers.get('authorization')).toBe('Bearer SECRET')
    expect(ctx.options.credentials).toBe('include')
  })

  it('canonicalises a per-call baseURL the way the URL parser will, before judging it', async () => {
    // The same shapes `isSameOrigin` defends against on the request, now on the base: a naive
    // `^https?://` test reads each of these as relative — and a relative base is accepted outright
    // under the BFF mount, which would send the sealed cookie and bearer to a foreign host.
    for (const hostile of ['//evil.example', ' https://evil.example', 'https:/\\evil.example', '\thttps://evil.example']) {
      const { opts } = build({ baseURL: '/api', origin: 'https://app.test', isServer: true, getCookieHeader: () => 'lukk=sealed', getBearer: () => 'SECRET' })
      const ctx = { request: '/me', options: { headers: new Headers(), baseURL: hostile } as { headers: Headers, credentials?: string, baseURL?: string } }

      await opts.onRequest(ctx)

      expect(ctx.options.headers.get('authorization'), hostile).toBeNull()
      expect(ctx.options.headers.get('cookie'), hostile).toBeNull()
      expect(ctx.options.credentials, hostile).toBe('same-origin')
    }
  })

  it('withholds the SSR cookie from a cross-origin per-call baseURL, not just the bearer', async () => {
    // The per-call cases all ran as the client, so `getCookieHeader` was never consulted and a rule that
    // dropped only the bearer looked correct — while the sealed session cookie still rode to the target.
    const { opts } = build({ baseURL: 'https://api.example.com', isServer: true, getCookieHeader: () => 'lukk=sealed', getBearer: () => 'SECRET' })
    const ctx = { request: '/me', options: { headers: new Headers(), baseURL: 'https://collector.example' } as { headers: Headers, credentials?: string, baseURL?: string } }

    await opts.onRequest(ctx)

    expect(ctx.options.headers.get('cookie')).toBeNull()
    expect(ctx.options.headers.get('authorization')).toBeNull()
  })

  it('REFUSES a relative per-call baseURL when the API is cross-origin — it resolves against the document, not the API', async () => {
    const { opts } = build({ baseURL: 'https://api.example.com', getBearer: () => 'SECRET' })
    const ctx = { request: '/thing', options: { headers: new Headers(), baseURL: '/local' } as { headers: Headers, credentials?: string, baseURL?: string } }

    await opts.onRequest(ctx)

    expect(ctx.options.headers.get('authorization')).toBeNull()
    expect(ctx.options.credentials).toBe('same-origin')
  })

  it('REFUSES them for a cross-origin per-call baseURL too — ofetch applies it after this hook', async () => {
    const { opts } = build({ baseURL: 'https://api.example.com', getBearer: () => 'SECRET' })
    const ctx = { request: '/me', options: { headers: new Headers(), baseURL: 'https://collector.example' } as { headers: Headers, credentials?: string, baseURL?: string } }

    await opts.onRequest(ctx)

    expect(ctx.options.headers.get('authorization')).toBeNull()
    expect(ctx.options.credentials).toBe('same-origin')
  })

  it('REFUSES cookie + bearer + credentials for a cross-origin absolute URL', async () => {
    const { opts } = build({ isServer: true, getCookieHeader: () => 'lukk=sealed', getBearer: () => 'tok' })
    const ctx = reqCtx('https://evil.example/steal')
    await opts.onRequest(ctx)
    expect(ctx.options.headers.has('cookie')).toBe(false)
    expect(ctx.options.headers.has('authorization')).toBe(false)
    expect(ctx.options.credentials).toBe('same-origin')
  })

  it('attaches the bearer for an absolute URL that matches baseURL origin', async () => {
    const { opts } = build({ baseURL: 'https://api.example.com', getBearer: () => 'tok' })
    const ctx = reqCtx('https://api.example.com/me')
    await opts.onRequest(ctx)
    expect(ctx.options.headers.get('authorization')).toBe('Bearer tok')
    expect(ctx.options.credentials).toBe('include')
  })

  it('accepts a Request object for the URL', async () => {
    const { opts } = build({ getBearer: () => 'tok' })
    const ctx = { request: { url: '/me' } as unknown as string, options: { headers: new Headers() } as { headers: Headers, credentials?: string } }
    await opts.onRequest(ctx)
    expect(ctx.options.headers.get('authorization')).toBe('Bearer tok')
  })

  it('treats an unparseable absolute URL as cross-origin (refuses credentials)', async () => {
    const { opts } = build({ baseURL: 'https://api.example.com', getBearer: () => 'tok' })
    const ctx = reqCtx('https://exa mple.com/x') // matches http(s):// but `new URL` throws
    await opts.onRequest(ctx)
    expect(ctx.options.headers.has('authorization')).toBe(false)
    expect(ctx.options.credentials).toBe('same-origin')
  })
})

describe('createLukkFetch — onResponse redirects', () => {
  it('surfaces an unfollowed 3xx via onRedirect', async () => {
    const { opts, deps } = build()
    await opts.onResponse({ response: { status: 302, type: 'default', headers: new Headers({ location: '/login' }) } })
    expect(deps.onRedirect).toHaveBeenCalledWith('/login')
  })

  it('ignores a normal 2xx response', async () => {
    const { opts, deps } = build()
    await opts.onResponse({ response: { status: 200, type: 'default', headers: new Headers() } })
    expect(deps.onRedirect).not.toHaveBeenCalled()
  })

  it('ignores a browser opaque redirect (no readable target)', async () => {
    const { opts, deps } = build()
    await opts.onResponse({ response: { status: 0, type: 'opaqueredirect', headers: new Headers() } })
    expect(deps.onRedirect).not.toHaveBeenCalled()
  })

  it('ignores a 3xx with no Location header', async () => {
    const { opts, deps } = build()
    await opts.onResponse({ response: { status: 302, type: 'default', headers: new Headers() } })
    expect(deps.onRedirect).not.toHaveBeenCalled()
  })

  it('ignores a 4xx/5xx (not a redirect) reaching onResponse', async () => {
    const { opts, deps } = build()
    await opts.onResponse({ response: { status: 500, type: 'default', headers: new Headers() } })
    expect(deps.onRedirect).not.toHaveBeenCalled()
  })
})

describe('createLukkFetch — onResponseError', () => {
  const errCtx = (status: number, data: unknown, retry: unknown = 0) => ({
    response: { status, statusText: 'Err', _data: data, headers: new Headers() },
    options: { retry },
  })

  it('rejects with a typed LukkError (message + validation bag) on a non-retryable 4xx', async () => {
    const { opts } = build()
    await expect(opts.onResponseError(errCtx(422, { message: 'Invalid', errors: { email: ['taken'] } })))
      .rejects.toEqual({ status: 422, message: 'Invalid', errors: { email: ['taken'] } })
  })

  it('falls back to statusText and omits errors when there is no parsed body', async () => {
    const { opts } = build()
    await expect(opts.onResponseError(errCtx(500, undefined))).rejects.toEqual({ status: 500, message: 'Err' })
  })

  it('refreshes (single-flight) and does NOT throw on a direct-mode 401 so ofetch retries', async () => {
    const { opts, deps } = build({ canRefresh: true })
    await expect(opts.onResponseError(errCtx(401, {}, 1))).resolves.toBeUndefined()
    expect(deps.refresh).toHaveBeenCalledTimes(1)
  })

  it('throws (no retry) when the refresh fails', async () => {
    const { opts, deps } = build({ canRefresh: true, refresh: vi.fn(async () => null) })
    await expect(opts.onResponseError(errCtx(401, { message: 'nope' }, 1))).rejects.toMatchObject({ status: 401 })
    expect(deps.refresh).toHaveBeenCalledTimes(1)
  })

  it('does not refresh a 401 once the retry budget is spent', async () => {
    const { opts, deps } = build({ canRefresh: true })
    await expect(opts.onResponseError(errCtx(401, {}, 0))).rejects.toMatchObject({ status: 401 })
    expect(deps.refresh).not.toHaveBeenCalled()
  })

  it('does not refresh a non-401 error', async () => {
    const { opts, deps } = build({ canRefresh: true })
    await expect(opts.onResponseError(errCtx(403, {}, 1))).rejects.toMatchObject({ status: 403 })
    expect(deps.refresh).not.toHaveBeenCalled()
  })
})

describe('createRequestFetch (server-BFF)', () => {
  it('routes each call through the request-aware fetch, merging shared options + per-call opts', async () => {
    const requestFetch = vi.fn(async () => ({ ok: true }))
    const { deps } = build({ baseURL: '/api' })
    const api = createRequestFetch(requestFetch, deps)

    // per-call opts merge over the shared options
    expect(await api('/me', { method: 'POST' })).toEqual({ ok: true })
    const [req, opts] = requestFetch.mock.calls[0] as [string, FetchOptions]
    expect(req).toBe('/me')
    expect(opts.baseURL).toBe('/api') // shared
    expect(opts.credentials).toBe('same-origin') // shared default; the hook upgrades a same-origin target
    expect(opts.redirect).toBe('manual') // shared
    expect(opts.method).toBe('POST') // per-call
    expect(typeof opts.onRequest).toBe('function') // interceptors carried through

    // default opts ({}) when none passed
    await api('/other')
    expect((requestFetch.mock.calls[1] as [string, FetchOptions])[1].baseURL).toBe('/api')
  })
})

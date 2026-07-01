import type { $Fetch } from 'ofetch'
import { describe, expect, it, vi } from 'vitest'
import { createLukkFetch, type LukkFetchDeps } from '../src/runtime/utils/create-lukk-fetch'

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
  it('sets baseURL, credentials, manual redirect', () => {
    const { opts } = build({ baseURL: 'https://api.example.com' })
    expect(opts.baseURL).toBe('https://api.example.com')
    expect(opts.credentials).toBe('include')
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

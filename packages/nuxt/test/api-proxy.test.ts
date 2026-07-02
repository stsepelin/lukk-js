import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __test } from './mocks/imports'
import type { TokenSession } from '../src/runtime/server/utils/refresh'

// Upstream (app-API) Set-Cookie the proxy would receive; the mock appends it like h3 does.
let upstreamSetCookie: string | string[] | undefined
// The fetch Response h3 hands to onResponse; a test can make it a redirect to exercise the guard.
let upstreamResponse: { status: number, type: string, headers: Headers }
const proxyRequest = vi.fn(async (event: { node: { res: { getHeader: (k: string) => unknown, setHeader: (k: string, v: unknown) => void, removeHeader: unknown } } }, target: string, opts?: { headers?: Record<string, string>, onResponse?: (e: unknown, r: unknown) => void }) => {
  // Simulate h3 appending the upstream Set-Cookie to whatever's already queued (the session).
  if (upstreamSetCookie !== undefined) {
    const arr = (v: unknown): unknown[] => (v === undefined ? [] : Array.isArray(v) ? v : [v])
    event.node.res.setHeader('set-cookie', [...arr(event.node.res.getHeader('set-cookie')), ...arr(upstreamSetCookie)])
  }
  // h3 calls onResponse after setting upstream headers, before streaming the body.
  if (opts?.onResponse) await opts.onResponse(event, upstreamResponse)
  return { target, headers: opts?.headers }
})

// The sealed session: controllable per-test. `readSession` unseals it read-only;
// `update` (only reached on the refresh path) mutates the data and, like h3, queues
// the rotated session cookie on the response.
let sessionId: string | undefined
let sessionData: TokenSession
let cookiePresent: boolean
let sealValid: boolean // false → the seal is present but tampered/expired (unseal throws)
let sealHasData: boolean // false → unseal resolves but carries no `data` (defensive `?? {}`)
const useSession = vi.fn(async (event: { node: { res: { setHeader: (k: string, v: unknown) => void } } }) => ({
  id: sessionId,
  data: sessionData,
  update: vi.fn(async (patch: TokenSession) => {
    Object.assign(sessionData, patch)
    event.node.res.setHeader('set-cookie', '__Host-lukk-session=rotated')
  }),
}))

vi.mock('h3', () => ({
  defineEventHandler: (fn: unknown) => fn,
  getRequestHeader: (event: { headers?: Record<string, string> }, name: string) => event.headers?.[name],
  getRequestIP: (event: { ip?: string }) => event.ip,
  getCookie: () => (cookiePresent ? 'sealed' : undefined),
  unsealSession: async () => {
    if (!sealValid) throw new Error('bad seal')
    return sealHasData ? { data: sessionData } : {}
  },
  useSession: (...args: unknown[]) => (useSession as (...a: unknown[]) => unknown)(...args),
  setResponseStatus: (event: { status: number }, status: number) => { event.status = status },
  proxyRequest: (...args: unknown[]) => (proxyRequest as (...a: unknown[]) => unknown)(...args),
}))

const refreshOnce = vi.fn<(s: unknown, b: string) => Promise<TokenSession | null>>()
vi.mock('../src/runtime/server/utils/refresh', () => ({ refreshOnce: (...a: unknown[]) => refreshOnce(...(a as [unknown, string])) }))

// eslint-disable-next-line import/first
import handler from '../src/runtime/server/api-proxy'

/** A minimal JWT (header.payload.sig) carrying just the given claims — not signed. */
function jwt(claims: Record<string, unknown>): string {
  const seg = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${seg({ alg: 'HS256' })}.${seg(claims)}.sig`
}
const freshJwt = () => jwt({ exp: Math.floor(Date.now() / 1000) + 3600 })
const expiredJwt = () => jwt({ exp: Math.floor(Date.now() / 1000) - 10 })

function ev(o: { path: string, method?: string, headers?: Record<string, string> }) {
  const headers: Record<string, unknown> = {}
  return {
    path: o.path,
    method: o.method ?? 'GET',
    headers: o.headers ?? {},
    status: 200,
    ip: '203.0.113.7' as string | undefined,
    node: { res: {
      statusCode: 200,
      getHeader: vi.fn((k: string) => headers[k]),
      setHeader: vi.fn((k: string, v: unknown) => { headers[k] = v }),
      removeHeader: vi.fn((k: string) => { headers[k] = undefined }),
    } },
  }
}
const run = (e: ReturnType<typeof ev>) => (handler as unknown as (e: unknown) => Promise<unknown>)(e)
const sameOrigin = { origin: 'https://app.test', host: 'app.test' }

beforeEach(() => {
  __test.runtimeConfig.lukk = { apiPath: '/api', apiTarget: 'https://laravel.test', apiForceJson: true, baseURL: 'https://api/auth', sessionPassword: 'x'.repeat(32) } as unknown as Record<string, unknown>
  sessionId = 'sid'
  sessionData = { access: 'tok' } // authenticated, no refresh token → the refresh branch stays off
  cookiePresent = true
  sealValid = true
  sealHasData = true
  upstreamSetCookie = undefined
  upstreamResponse = { status: 200, type: 'default', headers: new Headers() }
  refreshOnce.mockReset()
})
afterEach(() => { __test.reset(); vi.clearAllMocks() })

describe('app-API proxy', () => {
  it('injects the bearer, strips the cookie/authorization + spoofable forwarding headers, sets a trusted XFF', async () => {
    await run(ev({ path: '/api/users?page=2', headers: { 'cookie': 'lukk-session=sealed', 'authorization': 'Bearer forged', 'x-forwarded-for': '9.9.9.9' } }))
    expect(proxyRequest).toHaveBeenCalledWith(
      expect.anything(),
      'https://laravel.test/users?page=2',
      expect.objectContaining({
        streamRequest: true,
        headers: expect.objectContaining({
          'accept': 'application/json', // force JSON so Laravel renders clean 401/422
          'cookie': '',
          'authorization': 'Bearer tok',
          'x-forwarded-for': '203.0.113.7', // trusted connection IP, not the spoofed 9.9.9.9
          'x-forwarded-host': '',
          'forwarded': '',
          'x-real-ip': '',
        }),
      }),
    )
  })

  it('forwards the browser Accept when forceJson is disabled', async () => {
    __test.runtimeConfig.lukk = { ...__test.runtimeConfig.lukk, apiForceJson: false } as unknown as Record<string, unknown>
    await run(ev({ path: '/api/report.pdf', headers: { accept: 'application/pdf' } }))
    expect(proxyRequest).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ headers: expect.objectContaining({ accept: 'application/pdf' }) }))
  })

  it('forwards redirect:manual so an upstream 3xx is never followed (bearer not re-emitted)', async () => {
    await run(ev({ path: '/api/users' }))
    expect(proxyRequest).toHaveBeenCalledWith(
      expect.anything(), expect.anything(),
      expect.objectContaining({ fetchOptions: expect.objectContaining({ redirect: 'manual' }) }),
    )
  })

  it('rejects an opaque upstream redirect with a 502 (not a masked empty 200)', async () => {
    upstreamResponse = { status: 0, type: 'opaqueredirect', headers: new Headers() }
    const e = ev({ path: '/api/users' })
    await run(e)
    expect(e.node.res.statusCode).toBe(502)
  })

  it('rejects a 3xx upstream response with a 502', async () => {
    upstreamResponse = { status: 302, type: 'default', headers: new Headers() }
    const e = ev({ path: '/api/users' })
    await run(e)
    expect(e.node.res.statusCode).toBe(502)
  })

  it('sends an empty Accept when forceJson is off and the browser sent none', async () => {
    __test.runtimeConfig.lukk = { ...__test.runtimeConfig.lukk, apiForceJson: false } as unknown as Record<string, unknown>
    await run(ev({ path: '/api/x' }))
    expect(proxyRequest).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ headers: expect.objectContaining({ accept: '' }) }))
  })

  it('streams uploads without clobbering the multipart Content-Type', async () => {
    await run(ev({ path: '/api/upload', method: 'POST', headers: { ...sameOrigin, 'content-type': 'multipart/form-data; boundary=xyz' } }))
    const opts = (proxyRequest.mock.calls[0] as unknown[])[2] as { streamRequest?: boolean, headers?: Record<string, string> }
    expect(opts.streamRequest).toBe(true) // body streamed, not buffered
    expect(opts.headers).not.toHaveProperty('content-type') // forwarded by h3, not overridden
  })

  it('strips upstream Set-Cookie and marks the response non-cacheable', async () => {
    const e = ev({ path: '/api/me' })
    await run(e)
    expect(e.node.res.removeHeader).toHaveBeenCalledWith('set-cookie')
    expect(e.node.res.setHeader).toHaveBeenCalledWith('cache-control', 'private, no-store')
    // No refresh → no rotated session cookie restored.
    expect(e.node.res.setHeader).not.toHaveBeenCalledWith('set-cookie', expect.anything())
  })

  it('strips upstream Set-Cookie even when the app API sets one (default: no allow-list)', async () => {
    upstreamSetCookie = ['locale=en; Path=/', 'tracking=x; Path=/']
    const e = ev({ path: '/api/me' })
    await run(e)
    expect(e.node.res.removeHeader).toHaveBeenCalledWith('set-cookie')
    expect(e.node.res.getHeader('set-cookie')).toBeUndefined() // nothing forwarded
  })

  it('forwards only allow-listed upstream cookies, stripping the rest', async () => {
    ;(__test.runtimeConfig.lukk as Record<string, unknown>).apiForwardSetCookie = ['locale']
    upstreamSetCookie = ['locale=en; Path=/', 'tracking=xyz; Path=/', 'malformed-no-equals'] // malformed → name '', dropped
    const e = ev({ path: '/api/me' })
    await run(e)
    expect(e.node.res.getHeader('set-cookie')).toEqual(['locale=en; Path=/'])
  })

  it('never forwards the sealed session cookie, even if allow-listed (upstream cannot overwrite it)', async () => {
    ;(__test.runtimeConfig.lukk as Record<string, unknown>).apiForwardSetCookie = ['__Host-lukk-session', 'locale']
    upstreamSetCookie = ['__Host-lukk-session=EVIL; Path=/', 'locale=en']
    const e = ev({ path: '/api/me' })
    await run(e)
    // Only `locale` survives; the forged session cookie is dropped despite being listed.
    expect(e.node.res.getHeader('set-cookie')).toEqual(['locale=en'])
  })

  it('carries the rotated session cookie AND allow-listed upstream cookies together', async () => {
    sessionData = { access: expiredJwt(), refresh: 'r' }
    refreshOnce.mockResolvedValue({ access: 'new-tok', refresh: 'r2' })
    ;(__test.runtimeConfig.lukk as Record<string, unknown>).apiForwardSetCookie = ['locale']
    upstreamSetCookie = ['locale=en']
    const e = ev({ path: '/api/me' })
    await run(e)
    expect(e.node.res.getHeader('set-cookie')).toEqual(['__Host-lukk-session=rotated', 'locale=en'])
  })

  it('sets an empty XFF when the connection IP is unknown', async () => {
    const e = ev({ path: '/api/x' })
    e.ip = undefined
    await run(e)
    expect(proxyRequest).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ headers: expect.objectContaining({ 'x-forwarded-for': '' }) }))
  })

  it('forwards without a bearer when there is no session cookie (and never opens a session)', async () => {
    cookiePresent = false
    await run(ev({ path: '/api/me' }))
    expect(useSession).not.toHaveBeenCalled()
    expect(proxyRequest).toHaveBeenCalledWith(
      expect.anything(),
      'https://laravel.test/me',
      expect.objectContaining({ headers: expect.objectContaining({ cookie: '', authorization: '' }) }),
    )
  })

  it('does not open (nor mint) a session for an expired/tampered seal — forwards without a bearer', async () => {
    sealValid = false // present cookie, but the seal is undecodable
    const e = ev({ path: '/api/me' })
    await run(e)
    expect(useSession).not.toHaveBeenCalled() // read-only path never mints a fresh empty session cookie
    expect(refreshOnce).not.toHaveBeenCalled()
    expect(proxyRequest).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ headers: expect.objectContaining({ authorization: '' }) }))
    expect(e.node.res.setHeader).not.toHaveBeenCalledWith('set-cookie', expect.anything())
  })

  it('forwards without a bearer when the session holds no access token', async () => {
    sessionData = {}
    await run(ev({ path: '/api/me' }))
    expect(proxyRequest).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ headers: expect.objectContaining({ authorization: '' }) }))
    expect(refreshOnce).not.toHaveBeenCalled()
  })

  it('forwards without a bearer when the unsealed session carries no data', async () => {
    sealHasData = false
    await run(ev({ path: '/api/me' }))
    expect(useSession).not.toHaveBeenCalled()
    expect(proxyRequest).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ headers: expect.objectContaining({ authorization: '' }) }))
  })

  it('does not refresh a still-valid access token even when a refresh token exists', async () => {
    sessionData = { access: freshJwt(), refresh: 'r' }
    await run(ev({ path: '/api/me' }))
    expect(refreshOnce).not.toHaveBeenCalled()
    expect(proxyRequest).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ headers: expect.objectContaining({ authorization: `Bearer ${sessionData.access}` }) }))
  })

  it('proactively refreshes an expired access token, injects the new one, and carries the rotated session cookie through', async () => {
    sessionData = { access: expiredJwt(), refresh: 'r' }
    refreshOnce.mockResolvedValue({ access: 'new-tok', refresh: 'r2' })
    const e = ev({ path: '/api/me' })
    await run(e)
    expect(refreshOnce).toHaveBeenCalledOnce()
    expect(proxyRequest).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ headers: expect.objectContaining({ authorization: 'Bearer new-tok' }) }))
    // Upstream Set-Cookie stripped, but the rotated session cookie restored.
    expect(e.node.res.removeHeader).toHaveBeenCalledWith('set-cookie')
    expect(e.node.res.setHeader).toHaveBeenCalledWith('set-cookie', '__Host-lukk-session=rotated')
  })

  it('lets a failed refresh fall through to an upstream 401 (revoked session), keeping the stale bearer', async () => {
    const stale = expiredJwt()
    sessionData = { access: stale, refresh: 'r' }
    refreshOnce.mockResolvedValue(null)
    const e = ev({ path: '/api/me' })
    await run(e)
    expect(proxyRequest).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ headers: expect.objectContaining({ authorization: `Bearer ${stale}` }) }))
    expect(e.node.res.setHeader).not.toHaveBeenCalledWith('set-cookie', expect.anything())
  })

  it('treats a malformed or exp-less access token as expired and refreshes', async () => {
    sessionData = { access: 'not-a-jwt', refresh: 'r' }
    refreshOnce.mockResolvedValue({ access: 'new-tok', refresh: 'r2' })
    await run(ev({ path: '/api/a' }))
    expect(refreshOnce).toHaveBeenCalledOnce()

    refreshOnce.mockClear()
    sessionData = { access: jwt({ sub: 'no-exp' }), refresh: 'r' }
    refreshOnce.mockResolvedValue({ access: 'new-tok', refresh: 'r2' })
    await run(ev({ path: '/api/b' }))
    expect(refreshOnce).toHaveBeenCalledOnce()

    refreshOnce.mockClear()
    sessionData = { access: 'h.@@not-json@@.s', refresh: 'r' } // undecodable payload → treated as expired
    refreshOnce.mockResolvedValue({ access: 'new-tok', refresh: 'r2' })
    await run(ev({ path: '/api/c' }))
    expect(refreshOnce).toHaveBeenCalledOnce()
  })

  it('splits the query on the first ? only', async () => {
    await run(ev({ path: '/api/search?q=a?b=c' }))
    expect(proxyRequest).toHaveBeenCalledWith(expect.anything(), 'https://laravel.test/search?q=a?b=c', expect.anything())
  })

  it('allows a same-origin POST', async () => {
    await run(ev({ path: '/api/orders', method: 'POST', headers: sameOrigin }))
    expect(proxyRequest).toHaveBeenCalledOnce()
  })

  it('allows a non-GET request that carries no Origin (non-browser client)', async () => {
    await run(ev({ path: '/api/orders', method: 'POST' }))
    expect(proxyRequest).toHaveBeenCalledOnce()
  })

  it('proxies the mount root', async () => {
    await run(ev({ path: '/api' }))
    expect(proxyRequest).toHaveBeenCalledWith(expect.anything(), 'https://laravel.test/', expect.anything())
  })

  it('rejects a cross-origin state-changing request (CSRF)', async () => {
    const e = ev({ path: '/api/orders', method: 'POST', headers: { origin: 'https://evil.com', host: 'app.test' } })
    await run(e)
    expect(e.status).toBe(403)
    expect(proxyRequest).not.toHaveBeenCalled()
  })

  it('refuses to proxy the lukk BFF routes', async () => {
    const e = ev({ path: '/api/_lukk/login', method: 'POST', headers: sameOrigin })
    await run(e)
    expect(e.status).toBe(404)
    expect(proxyRequest).not.toHaveBeenCalled()
  })

  it('rejects a path outside the mount', async () => {
    const e = ev({ path: '/apixyz' })
    await run(e)
    expect(e.status).toBe(404)
    expect(proxyRequest).not.toHaveBeenCalled()
  })

  it('rejects a path that escapes the fixed target (SSRF / traversal)', async () => {
    __test.runtimeConfig.lukk = { ...__test.runtimeConfig.lukk, apiTarget: 'https://laravel.test/v1' } as unknown as Record<string, unknown>
    const e = ev({ path: '/api/../../etc/passwd' })
    await run(e)
    expect(e.status).toBe(400)
    expect(proxyRequest).not.toHaveBeenCalled()
  })
})

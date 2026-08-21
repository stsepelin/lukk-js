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
    node: { req: { socket: { remoteAddress: '203.0.113.7' } }, res: {
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

  it('blanks the step-up confirmation header a client tried to smuggle through', async () => {
    // Symmetric with `authorization`: in BFF mode the browser never legitimately holds a step-up
    // token, so one arriving from the client must not reach the app API — where a consumer may gate
    // routes on lukk's confirmation middleware. `bff.ts` is immune (it builds its headers from
    // scratch); this proxy forwards unknown headers by default, so it has to blank this one.
    ;(__test.runtimeConfig as Record<string, unknown>).public = { lukk: { confirmationHeader: 'X-Step-Up' } }
    await run(ev({ path: '/api/me', headers: { 'x-step-up': 'forged-token' } }))
    expect(proxyRequest.mock.calls[0]![2]!.headers!['x-step-up']).toBe('')
  })

  it('blanks the default confirmation header when public config carries none', async () => {
    await run(ev({ path: '/api/me', headers: { 'x-lukk-confirmation': 'forged-token' } }))
    expect(proxyRequest.mock.calls[0]![2]!.headers!['x-lukk-confirmation']).toBe('')
  })

  it('injects the SERVER-held step-up token, so a confirm-gated app route stays reachable', async () => {
    // Blanking alone would have made an app-API route behind lukk's confirm middleware unreachable
    // through this proxy — it only "worked" before via the header the browser set. Injecting from
    // the sealed session is how the auth proxy has always done it.
    sessionData = { access: 'tok', confirmation: 'server-ct' }
    await run(ev({ path: '/api/me', headers: { 'x-lukk-confirmation': 'forged-token' } }))
    expect(proxyRequest.mock.calls[0]![2]!.headers!['x-lukk-confirmation']).toBe('server-ct')
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

  it('never forwards ANY lukk session cookie — its own OR a co-hosted app\'s — even if allow-listed', async () => {
    ;(__test.runtimeConfig.lukk as Record<string, unknown>).cookieNamespace = 'admin' // → __Host-lukk-admin-session
    ;(__test.runtimeConfig.lukk as Record<string, unknown>).apiForwardSetCookie = ['__Host-lukk-admin-session', '__Host-lukk-session', 'locale']
    upstreamSetCookie = ['__Host-lukk-admin-session=EVIL; Path=/', '__Host-lukk-session=OTHER; Path=/', 'locale=en']
    const e = ev({ path: '/api/me' })
    await run(e)
    // Both this app's namespaced session cookie AND a co-hosted app's default-named one are dropped —
    // no lukk session cookie is ever forwardable, whatever the allow-list says. Only `locale` survives.
    expect(e.node.res.getHeader('set-cookie')).toEqual(['locale=en'])
  })

  it('carries the rotated session cookie AND allow-listed upstream cookies together', async () => {
    sessionData = { access: expiredJwt(), refresh: 'r' }
    refreshOnce.mockResolvedValue({ pair: { access: 'new-tok', refresh: 'r2' }, retryable: false })
    ;(__test.runtimeConfig.lukk as Record<string, unknown>).apiForwardSetCookie = ['locale']
    upstreamSetCookie = ['locale=en']
    const e = ev({ path: '/api/me' })
    await run(e)
    expect(e.node.res.getHeader('set-cookie')).toEqual(['__Host-lukk-session=rotated', 'locale=en'])
  })

  it('forwards the visitor IP from a trusted clientIpHeader, not the socket address', async () => {
    // Behind nginx/Cloudflare the socket address is the PROXY, so an upstream keying `throttle:5,1`
    // on `$request->ip()` throttles every visitor as one identity. Opting into a trusted header is
    // what lets the API tell visitors apart.
    ;(__test.runtimeConfig.lukk as Record<string, unknown>).clientIpHeader = 'cf-connecting-ip'
    await run(ev({ path: '/api/me', headers: { 'cf-connecting-ip': '198.51.100.23' } }))
    expect(proxyRequest).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({
      headers: expect.objectContaining({ 'x-forwarded-for': '198.51.100.23' }),
    }))
  })

  it('ignores a client-supplied x-forwarded-for even when a trusted header is configured', async () => {
    ;(__test.runtimeConfig.lukk as Record<string, unknown>).clientIpHeader = 'cf-connecting-ip'
    await run(ev({ path: '/api/me', headers: { 'x-forwarded-for': '1.2.3.4', 'cf-connecting-ip': '198.51.100.23' } }))
    const { headers } = proxyRequest.mock.calls[0]![2]!
    expect(headers!['x-forwarded-for']).toBe('198.51.100.23')
    // The browser's own chain is replaced, never merged — so it can't prepend a forged identity.
    expect(headers!['x-forwarded-for']).not.toContain('1.2.3.4')
  })

  it('falls back to the socket address when the trusted header is missing or malformed', async () => {
    ;(__test.runtimeConfig.lukk as Record<string, unknown>).clientIpHeader = 'cf-connecting-ip'
    await run(ev({ path: '/api/me', headers: { 'x-forwarded-for': '1.2.3.4' } }))
    expect(proxyRequest.mock.calls[0]![2]!.headers!['x-forwarded-for']).toBe('203.0.113.7')
    proxyRequest.mockClear()
    await run(ev({ path: '/api/me', headers: { 'cf-connecting-ip': 'not-an-ip' } }))
    expect(proxyRequest.mock.calls[0]![2]!.headers!['x-forwarded-for']).toBe('203.0.113.7')
  })

  it('sets an empty XFF when the connection IP is unknown', async () => {
    // The shape on every non-Node preset: the mock socket carries no address, so `clientIpHeader`
    // is the only way the upstream ever learns the caller there.
    const e = ev({ path: '/api/x' })
    e.node.req.socket.remoteAddress = ''
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
    refreshOnce.mockResolvedValue({ pair: { access: 'new-tok', refresh: 'r2' }, retryable: false })
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
    refreshOnce.mockResolvedValue({ pair: null, retryable: false })
    const e = ev({ path: '/api/me' })
    await run(e)
    expect(proxyRequest).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ headers: expect.objectContaining({ authorization: `Bearer ${stale}` }) }))
    expect(e.node.res.setHeader).not.toHaveBeenCalledWith('set-cookie', expect.anything())
  })

  it('treats a malformed or exp-less access token as expired and refreshes', async () => {
    sessionData = { access: 'not-a-jwt', refresh: 'r' }
    refreshOnce.mockResolvedValue({ pair: { access: 'new-tok', refresh: 'r2' }, retryable: false })
    await run(ev({ path: '/api/a' }))
    expect(refreshOnce).toHaveBeenCalledOnce()

    refreshOnce.mockClear()
    sessionData = { access: jwt({ sub: 'no-exp' }), refresh: 'r' }
    refreshOnce.mockResolvedValue({ pair: { access: 'new-tok', refresh: 'r2' }, retryable: false })
    await run(ev({ path: '/api/b' }))
    expect(refreshOnce).toHaveBeenCalledOnce()

    refreshOnce.mockClear()
    sessionData = { access: 'h.@@not-json@@.s', refresh: 'r' } // undecodable payload → treated as expired
    refreshOnce.mockResolvedValue({ pair: { access: 'new-tok', refresh: 'r2' }, retryable: false })
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
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const e = ev({ path: '/api/../../etc/passwd' })
    const body = await run(e) as { message: string }
    expect(e.status).toBe(400)
    expect(body).toEqual({ message: 'Invalid path.' })
    expect(proxyRequest).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('reports a misconfigured api.target as a config fault, not as "Invalid path."', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    __test.runtimeConfig.lukk = { ...__test.runtimeConfig.lukk, apiTarget: 'undefined/api' } as unknown as Record<string, unknown>

    const e = ev({ path: '/api/me' })
    const body = await run(e) as { message: string }

    expect(e.status).toBe(500) // a deployment fault, so it must page someone — not a 4xx
    expect(body.message).toContain('Proxy target could not be resolved')
    expect(String(error.mock.calls[0]![0])).toContain('undefined/api')
    expect(proxyRequest).not.toHaveBeenCalled()
    error.mockRestore()
  })
})

describe('proxy failure diagnostics', () => {
  it('surfaces the underlying cause, and still lets the failure propagate', async () => {
    // h3 swallows a failed fetch into an opaque 502 with the reason only on `error.cause`, which
    // Nuxt doesn't surface — so an unreachable upstream and an illegal outgoing request look
    // identical. Shipping 0.10.0 with exactly that cost a user a bisect.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const boom = Object.assign(new Error('fetch failed'), { cause: { message: `cause-${Math.random()}` } })
    proxyRequest.mockRejectedValueOnce(boom)

    await expect(run(ev({ path: '/api/x', headers: { ...sameOrigin } }))).rejects.toBe(boom)

    expect(error).toHaveBeenCalledOnce()
    expect(String(error.mock.calls[0]![0])).toContain(boom.cause.message)
  })

  it('logs once per distinct cause, not once per request', async () => {
    // An upstream outage fails EVERY request with the same cause. Logging per request turns a
    // downstream problem into a log-cost problem and buries whatever else is happening — the same
    // reasoning `reportUnusableBase` and the escape logger in this file already encode.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const cause = { message: `outage-${Math.random()}` }

    for (let i = 0; i < 5; i++) {
      proxyRequest.mockRejectedValueOnce(Object.assign(new Error('fetch failed'), { cause }))
      await expect(run(ev({ path: '/api/x', headers: { ...sameOrigin } }))).rejects.toThrow()
    }

    expect(error).toHaveBeenCalledOnce()
  })

  it('still reports a DIFFERENT failure — suppression must not hide a new one', async () => {
    // The message exists to tell "can't reach the upstream" apart from "built an illegal request".
    // A blanket once-per-process would hide the second behind the first.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    for (const message of [`first-${Math.random()}`, `second-${Math.random()}`]) {
      proxyRequest.mockRejectedValueOnce(Object.assign(new Error('fetch failed'), { cause: { message } }))
      await expect(run(ev({ path: '/api/x', headers: { ...sameOrigin } }))).rejects.toThrow()
    }

    expect(error).toHaveBeenCalledTimes(2)
  })

  it('stays useful when the failure carries no cause', async () => {
    // A bare network error has no `cause`; the message must not trail an "undefined".
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    proxyRequest.mockRejectedValueOnce(new Error(`bare-${Math.random()}`))

    await expect(run(ev({ path: '/api/x', headers: { ...sameOrigin } }))).rejects.toThrow()

    expect(String(error.mock.calls[0]![0])).toContain('app-API proxy failed')
    expect(String(error.mock.calls[0]![0])).not.toContain('undefined')
  })
})

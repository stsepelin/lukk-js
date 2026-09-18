import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __test } from './mocks/imports'
import type { TokenSession } from '../src/runtime/server/utils/refresh'

// Upstream (app-API) Set-Cookie the proxy would receive; the mock appends it like h3 does.
let upstreamSetCookie: string | string[] | undefined
// The fetch Response h3 hands to onResponse; a test can make it a redirect to exercise the guard.
let upstreamResponse: { status: number, type: string, headers: Headers }
const proxyRequest = vi.fn(async (event: { node: { res: { statusCode: number, getHeader: (k: string) => unknown, setHeader: (k: string, v: unknown) => void, removeHeader: unknown } } }, target: string, opts?: { headers?: Record<string, string>, onResponse?: (e: unknown, r: unknown) => void }) => {
  // Simulate h3 appending the upstream Set-Cookie to whatever's already queued (the session).
  if (upstreamSetCookie !== undefined) {
    const arr = (v: unknown): unknown[] => (v === undefined ? [] : Array.isArray(v) ? v : [v])
    event.node.res.setHeader('set-cookie', [...arr(event.node.res.getHeader('set-cookie')), ...arr(upstreamSetCookie)])
  }
  // `sendProxy` copies the upstream STATUS too — through `sanitizeStatusCode`, which turns a status
  // of 0 (undici's opaque redirect) into the empty 200 the 3xx guard exists to catch — and it does so
  // before `onResponse` runs. Without this the mock made every upstream status look like the
  // handler's own, so "passes 500 through" and "rewrote 500 to 502" were indistinguishable.
  event.node.res.statusCode = upstreamResponse.status >= 100 && upstreamResponse.status <= 999 ? upstreamResponse.status : 200
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

const h3note = vi.hoisted(() => ({ value: undefined as string | undefined }))

vi.mock('h3', () => ({
  defineEventHandler: (fn: unknown) => fn,
  // Case-insensitive, like h3 and like the wire: a case-sensitive mock makes a correct read look
  // unpinned, and hides a real one for any header the proxy reads by a CONFIGURED name.
  getRequestHeader: (event: { headers?: Record<string, string> }, name: string) =>
    Object.entries(event.headers ?? {}).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1],
  getRequestIP: (event: { ip?: string }) => event.ip,
  getCookie: (_event: unknown, name: string) => (/-logout$|-signed-out$/.test(name) ? h3note.value : (cookiePresent ? 'sealed' : undefined)),
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
const revokeDroppedSession = vi.fn()
vi.mock('../src/runtime/server/revoke-dropped', () => ({ revokeDroppedSession: (...a: unknown[]) => revokeDroppedSession(...a) }))

// eslint-disable-next-line import/first
import handler from '../src/runtime/server/api-proxy'
// eslint-disable-next-line import/first
import { endSession, forgetEndedSessions, markSessionEnded } from '../src/runtime/server/ended-sessions'

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
afterEach(() => { __test.reset(); vi.clearAllMocks(); h3note.value = undefined })

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

  it('attaches no session while the browser\'s logout note is on the request — a render right now must not show that account', async () => {
    h3note.value = '1'
    await run(ev({ path: '/api/users', headers: { cookie: '__Host-lukk-session=sealed; __Host-lukk-logout=1' } }))
    const headers = (proxyRequest.mock.calls[0]![2] as { headers: Record<string, string> }).headers
    expect(headers.authorization).toBe('')
    expect(useSession).not.toHaveBeenCalled()
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

  it('blanks the sealed-session REQUEST header, under the exact name h3 would read it from', async () => {
    // h3 accepts a sealed session from `x-<cookie name>-session` unless told not to. Every
    // `useSession` call here says `sessionHeader: false`, but the app API is a different server with
    // its own h3 — so the name is blanked on the way out too. Blanked under exactly that name: one
    // case or spelling off and the forged seal travels on untouched.
    await run(ev({ path: '/api/me', headers: { 'x-__host-lukk-session-session': 'forged-seal' } }))
    const headers = proxyRequest.mock.calls[0]![2]!.headers!
    expect(headers['x-__host-lukk-session-session']).toBe('')
  })

  it('does not let a client use Connection to strip the headers this proxy sets', async () => {
    // RFC 9110 §7.6.1 says a proxy removes the fields `Connection` names — so naming `authorization`
    // there would strip the injected bearer, and naming the step-up header would strip the token that
    // makes a confirm-gated route reachable. Both would present as a plain 401/403 from the app API,
    // with nothing in the request to explain it. The proxy's own headers are exempt from that rule.
    sessionData = { access: 'tok', confirmation: 'server-ct' }
    const e = ev({ path: '/api/me', headers: {
      'connection': 'authorization, Accept, x-forwarded-for, via, content-type, x-lukk-confirmation, te',
      'content-type': 'multipart/form-data; boundary=xyz',
    } })
    await run(e)
    const headers = proxyRequest.mock.calls[0]![2]!.headers!
    expect(headers.authorization).toBe('Bearer tok')
    expect(headers.accept).toBe('application/json')
    expect(headers['x-forwarded-for']).toBe('203.0.113.7')
    expect(headers.via).toBe('1.1 lukk-nuxt')
    expect(headers['x-lukk-confirmation']).toBe('server-ct')
    expect(headers).not.toHaveProperty('content-type') // still h3's to forward, not blanked to ''
    expect(headers.te).toBe('') // a real hop-by-hop header is still blanked
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

  it('rewrites the whole 3xx range, at both edges, and never leaks the upstream Location', async () => {
    // A `redirect: 'manual'` fetch answers with the 3xx itself on workerd/Deno, headers and all.
    // Forwarding the Location downstream would hand the browser the redirect the proxy just refused
    // to follow — the browser would then follow it, without the bearer but with the visitor.
    for (const status of [300, 302, 399]) {
      upstreamResponse = { status, type: 'default', headers: new Headers() }
      const e = ev({ path: '/api/users' })
      await run(e)
      expect(e.node.res.statusCode).toBe(502)
      expect(e.node.res.removeHeader).toHaveBeenCalledWith('location')
    }
  })

  it('passes every other upstream status through untouched', async () => {
    // The 502 exists for a redirect this proxy refuses to follow, and for nothing else. Widening it
    // by a single status collapses the app API's own answers — a 400 validation error, a 404, a 500 —
    // into one indistinguishable gateway error, and takes the response body with them.
    for (const status of [200, 299, 400, 404, 500]) {
      upstreamResponse = { status, type: 'default', headers: new Headers() }
      const e = ev({ path: '/api/users' })
      await run(e)
      expect(e.node.res.statusCode).toBe(status)
      expect(e.node.res.removeHeader).not.toHaveBeenCalledWith('location')
    }
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

  it('reads an upstream cookie NAME exactly — no truncation, no leading whitespace', async () => {
    // Both halves guard the allow-list. A `Set-Cookie` with no `=` at all has no name, and must not
    // be able to impersonate an allow-listed one by having the check read all-but-its-last-character
    // (`locales` is not `locale`). And a value that arrives with the optional whitespace RFC 9110
    // permits after the colon is still that cookie, so the name has to be read past it — otherwise
    // one padding space is all it takes to slip a cookie by the `isSessionCookieName` guard too.
    ;(__test.runtimeConfig.lukk as Record<string, unknown>).apiForwardSetCookie = ['locale']
    upstreamSetCookie = ['locales', ' locale=en; Path=/']
    const e = ev({ path: '/api/me' })
    await run(e)
    expect(e.node.res.getHeader('set-cookie')).toEqual([' locale=en; Path=/'])
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

  it('sets an empty XFF when there is no socket at all, rather than throwing', async () => {
    // Some presets give `node.req` no socket whatsoever. Reading through it unguarded throws inside
    // the header bag — before `proxyRequest` is ever called — so an unset `clientIpHeader` would
    // take down every app-API request on that preset, as a TypeError with no hint of the cause.
    const e = ev({ path: '/api/x' })
    ;(e.node.req as { socket?: unknown }).socket = undefined
    await run(e)
    expect(proxyRequest.mock.calls[0]![2]!.headers!['x-forwarded-for']).toBe('')
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
    // Nothing replaced this session, so the pair it just minted is the one the browser is about to
    // hold — revoking it here would sign the visitor out one request after renewing them.
    expect(revokeDroppedSession).not.toHaveBeenCalled()
  })

  it('opens the read-write session under the hardened cookie options the re-seal writes back', async () => {
    // The rotate re-seals, which means h3 writes the cookie again from exactly these options — drop
    // one and the renewed session lands as a weaker cookie than the one it replaced. `sessionHeader:
    // false` closes h3's other door: without it a sealed session is accepted from the
    // `x-<name>-session` REQUEST header, an auth channel outside `__Host-`, Secure, HttpOnly and
    // SameSite=Strict. And the name has to be this app's, or the rotate re-seals the wrong cookie.
    sessionData = { access: expiredJwt(), refresh: 'r' }
    refreshOnce.mockResolvedValue({ pair: { access: 'new-tok', refresh: 'r2' }, retryable: false })
    await run(ev({ path: '/api/me' }))
    expect(useSession).toHaveBeenCalledWith(expect.anything(), {
      password: 'x'.repeat(32),
      name: '__Host-lukk-session',
      cookie: { sameSite: 'strict', secure: true, httpOnly: true, path: '/' },
      sessionHeader: false,
    })
  })

  describe('a session a sign-in replaced or a logout ended while this request was out', () => {
    // Re-sealing it would put the previous session back in the browser, over the newer cookie.
    afterEach(() => forgetEndedSessions())

    it('is not refreshed at all once it has ended', async () => {
      const stale = expiredJwt()
      sessionData = { access: stale, refresh: 'r', sid: 'session-A' }
      markSessionEnded('session-A')
      const e = ev({ path: '/api/me' })

      await run(e)

      expect(refreshOnce).not.toHaveBeenCalled()
      expect(proxyRequest).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ headers: expect.objectContaining({ authorization: `Bearer ${stale}` }) }))
      expect(e.node.res.setHeader).not.toHaveBeenCalledWith('set-cookie', expect.anything())
      // No rotate ran, so there is no dropped pair — and the revoke call would be made with none.
      expect(revokeDroppedSession).not.toHaveBeenCalled()
    })

    it('withholds the signed-out cookie a logout this request finished queued, when a sign-in replaced that session meanwhile', async () => {
      h3note.value = '1' // the request carried the browser's logout note; finish-logout ended its session
      // Including a session the logout's renewal re-sealed: this response is finalised after the upstream
      // answered, so landing it over a newer sign-in would put the browser back on the previous account.
      const queued = [
        '__Host-lukk-signed-out=1; Max-Age=10; Path=/',
        '__Host-lukk-session=RESEALED; Path=/; HttpOnly',
        'theme=dark; Path=/',
      ]
      const answer = async (replacedMeanwhile: boolean) => {
        const e = { ...ev({ path: '/api/me' }), context: { lukkEndedSession: { key: 'session-X', marker: '__Host-lukk-signed-out' } } }
        e.node.res.setHeader('set-cookie', [...queued])
        const original = proxyRequest.getMockImplementation()!
        proxyRequest.mockImplementationOnce(async (...args) => {
          if (replacedMeanwhile) await endSession('session-X', { replaced: true }) // a sign-in in another tab lands mid-request
          return original(...args)
        })
        await run(e)
        return e.node.res.getHeader('set-cookie')
      }

      expect(await answer(false)).toEqual(queued)
      expect(await answer(true)).toEqual(['theme=dark; Path=/'])
    })

    it('withholds the re-sealed cookie when the session ended while the upstream was answering', async () => {
      sessionData = { access: expiredJwt(), refresh: 'r', sid: 'session-A' }
      refreshOnce.mockResolvedValue({ pair: { access: 'new-tok', refresh: 'r2' }, retryable: false })
      const original = proxyRequest.getMockImplementation()!
      proxyRequest.mockImplementationOnce(async (...args) => {
        markSessionEnded('session-A') // a sign-in in another tab lands mid-request
        return original(...args)
      })
      const e = ev({ path: '/api/me' })

      await run(e)

      expect(e.node.res.getHeader('set-cookie')).toBeUndefined()
      expect(revokeDroppedSession).toHaveBeenCalledWith(e, { access: 'new-tok', refresh: 'r2' }, 'https://api/auth', '')
    })

    it('is not re-sealed, nor its new token used, when it ended during the refresh', async () => {
      const stale = expiredJwt()
      sessionData = { access: stale, refresh: 'r', sid: 'session-A' }
      refreshOnce.mockImplementation(async () => {
        markSessionEnded('session-A')
        return { pair: { access: 'new-tok', refresh: 'r2' }, retryable: false }
      })
      const e = ev({ path: '/api/me' })

      await run(e)

      expect(proxyRequest).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ headers: expect.objectContaining({ authorization: `Bearer ${stale}` }) }))
      expect(e.node.res.setHeader).not.toHaveBeenCalledWith('set-cookie', expect.anything())
      expect(revokeDroppedSession).toHaveBeenCalledWith(e, { access: 'new-tok', refresh: 'r2' }, 'https://api/auth', '')
    })
  })

  it('lets a failed refresh fall through to an upstream 401 (revoked session), keeping the stale bearer', async () => {
    const stale = expiredJwt()
    sessionData = { access: stale, refresh: 'r' }
    refreshOnce.mockResolvedValue({ pair: null, retryable: false })
    const e = ev({ path: '/api/me' })
    await run(e)
    expect(proxyRequest).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ headers: expect.objectContaining({ authorization: `Bearer ${stale}` }) }))
    expect(e.node.res.setHeader).not.toHaveBeenCalledWith('set-cookie', expect.anything())
    // The refresh minted nothing, so there is nothing to hand back for revocation.
    expect(revokeDroppedSession).not.toHaveBeenCalled()
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
    const body = await run(e)
    expect(e.status).toBe(403)
    // The body says which rule refused, and says nothing else — a 403 with an empty body reads as a
    // failed auth check and sends the caller looking at their session instead of their Origin.
    expect(body).toEqual({ message: 'Cross-origin request rejected.' })
    expect(proxyRequest).not.toHaveBeenCalled()
  })

  it('serves the dev-http shape when the session cookie is not Secure', async () => {
    // Two things hang off the one `secure` flag and must not diverge: the cookie name loses its
    // `__Host-` prefix (the browser rejects that prefix without Secure), and the Origin check stops
    // insisting on https — under `nuxi dev` over plain http there is no Secure cookie to downgrade,
    // and getting it backwards 403s every non-GET in dev.
    ;(__test.runtimeConfig.lukk as Record<string, unknown>).cookieSecure = false
    const e = ev({ path: '/api/orders', method: 'POST', headers: { origin: 'http://app.test', host: 'app.test' } })
    await run(e)
    expect(e.status).toBe(200)
    const headers = proxyRequest.mock.calls[0]![2]!.headers!
    expect(headers['x-lukk-session-session']).toBe('')
    expect(headers).not.toHaveProperty('x-__host-lukk-session-session')
  })

  it('refuses to proxy the lukk BFF routes', async () => {
    const e = ev({ path: '/api/_lukk/login', method: 'POST', headers: sameOrigin })
    const body = await run(e)
    expect(e.status).toBe(404)
    expect(body).toEqual({ message: 'Not found.' })
    expect(proxyRequest).not.toHaveBeenCalled()
  })

  it('refuses the BFF mount itself, not only the routes under it', async () => {
    // `/api/_lukk` has no trailing slash, so the `startsWith` half of the guard doesn't see it — and
    // without the exact-match half it falls straight through to the mount check and gets proxied to
    // the app API as `/_lukk`, handing the consumer's API the path lukk reserves for itself.
    const e = ev({ path: '/api/_lukk' })
    const body = await run(e)
    expect(e.status).toBe(404)
    expect(body).toEqual({ message: 'Not found.' })
    expect(proxyRequest).not.toHaveBeenCalled()
  })

  it('rejects a path outside the mount', async () => {
    const e = ev({ path: '/apixyz' })
    const body = await run(e)
    expect(e.status).toBe(404)
    // Deliberately the same opaque body as the BFF-route refusal: neither tells a prober which of
    // the two rules it hit, or that the mount exists at all.
    expect(body).toEqual({ message: 'Not found.' })
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
    // And which setting to go and fix. This proxy and the auth proxy both resolve a base from config;
    // an unlabelled message leaves an operator guessing between `api.target` and `baseURL`.
    expect(String(error.mock.calls[0]![0])).toContain('lukk `api.target`')
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

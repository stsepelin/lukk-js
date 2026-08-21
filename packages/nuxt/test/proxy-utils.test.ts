import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('h3', () => ({
  getRequestHeader: (event: { headers?: Record<string, string> }, name: string) => event.headers?.[name],
  setResponseStatus: (event: { status?: number }, status: number) => { event.status = status },
}))

// eslint-disable-next-line import/first
import { hopByHopHeaders, rejectUnresolvedTarget, resolveTarget, viaHeader, visitorIp } from '../src/runtime/server/proxy-utils'

const ev = () => ({ status: 200 } as { status: number })

afterEach(() => vi.restoreAllMocks())

describe('resolveTarget', () => {
  it('resolves a subpath under the base', () => {
    expect(resolveTarget('https://api.example.com/auth', '/login')).toBe('https://api.example.com/auth/login')
  })

  it('returns null for an unusable base (the config fault)', () => {
    expect(resolveTarget('undefined/auth', '/forgot-password')).toBeNull()
    expect(resolveTarget('', '/login')).toBeNull()
    // Parses as scheme `localhost:` with a null origin — containment would be meaningless.
    expect(resolveTarget('localhost:3000/auth', '/login')).toBeNull()
  })

  it('returns null for a subpath that escapes the base (the traversal fault)', () => {
    expect(resolveTarget('https://api.example.com/auth', '../admin')).toBeNull()
    expect(resolveTarget('https://api.example.com/auth', '%2e%2e/admin')).toBeNull()
  })

  it('resolves from the PARSED base, so surrounding whitespace is not a fake traversal', () => {
    // A stray space from a .env/YAML copy-paste survives the build gate (the URL parser trims it)
    // but used to slice into the raw target as `/auth%20/login` → containment fails → every single
    // request 400s and is logged as a traversal attempt. That's the misdiagnosis this file exists
    // to prevent, so the base must be canonicalised before use.
    expect(resolveTarget(' https://api.example.com/auth ', '/login')).toBe('https://api.example.com/auth/login')
  })

  it('ignores a query/fragment on the base instead of swallowing the subpath into it', () => {
    // `/auth?t=1` + `/login` naively resolves to `/auth?t=1/login`, which PASSES containment while
    // sending every route to the same upstream endpoint. The module rejects such a base at build;
    // a runtime override must still resolve the real path.
    expect(resolveTarget('https://api.example.com/auth?tenant=1', '/login')).toBe('https://api.example.com/auth/login')
    expect(resolveTarget('https://api.example.com/auth#frag', '/login')).toBe('https://api.example.com/auth/login')
  })

  it('keeps containment for a sibling path that merely shares a prefix', () => {
    expect(resolveTarget('https://api.example.com/auth', '../auth2/x')).toBeNull()
  })
})

describe('rejectUnresolvedTarget', () => {
  it('names a misconfigured base — 5xx, and logs the offending value server-side', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const event = ev()

    const body = rejectUnresolvedTarget(event, 'undefined/auth', '`baseURL`', '/forgot-password')

    // A server misconfiguration, not a bad request: 4xx would keep 5xx alerting silent through a
    // total auth outage and let CDNs file it as client noise.
    expect(event.status).toBe(500)
    // The regression this guards: a bad baseURL used to answer "Invalid path.", sending operators
    // hunting a route mismatch. The body now points at config — without echoing the value.
    expect(body.message).toContain('Proxy target could not be resolved')
    expect(body.message).not.toContain('undefined/auth')
    expect(error).toHaveBeenCalledOnce()
    expect(String(error.mock.calls[0]![0])).toContain('undefined/auth')
  })

  it('logs a broken base once per value, not once per request', () => {
    // Fixed server config → the message never changes, so an unauthenticated caller must not be
    // able to drive unbounded log volume against a misconfigured deploy.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const base = `undefined/auth-${Math.random()}` // unreported base, independent of test order

    for (let i = 0; i < 5; i++) expect(rejectUnresolvedTarget(ev(), base, '`baseURL`', '/x').message).toContain('could not be resolved')

    expect(error).toHaveBeenCalledOnce()
  })

  it('still reports a genuine path escape as an invalid path', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const event = ev()

    const body = rejectUnresolvedTarget(event, 'https://api.example.com/auth', '`baseURL`', '../admin')

    expect(event.status).toBe(400)
    expect(body).toEqual({ message: 'Invalid path.' })
    expect(warn).toHaveBeenCalledOnce()
    expect(String(warn.mock.calls[0]![0])).toContain('../admin')
  })

  // Last in the file on purpose: the escape-log budget is module-level, so exhausting it here
  // would silence the assertions above if this ran earlier.
  it('caps escape-rejection logging, which an unauthenticated caller can drive', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    for (let i = 0; i < 80; i++) rejectUnresolvedTarget(ev(), 'https://api.example.com/auth', '`baseURL`', `../${i}`)

    // Every request is still rejected; only the log line is bounded per process.
    expect(warn.mock.calls.length).toBeLessThanOrEqual(50)
    expect(String(warn.mock.calls.at(-1)?.[0])).toContain('further path rejections will not be logged')
  })
})

describe('visitorIp', () => {
  const req = (headers: Record<string, string>) => ({ headers } as never)

  it('yields nothing when no header is trusted, whatever the browser sent', () => {
    // The default. A client's own `x-forwarded-for` is never read, so it can't dictate identity.
    expect(visitorIp(req({ 'x-forwarded-for': '1.2.3.4' }))).toBe('')
    expect(visitorIp(req({ 'cf-connecting-ip': '1.2.3.4' }))).toBe('')
  })

  it('reads the visitor address from the configured trusted header', () => {
    expect(visitorIp(req({ 'cf-connecting-ip': '203.0.113.9' }), 'cf-connecting-ip')).toBe('203.0.113.9')
    expect(visitorIp(req({ 'x-real-ip': '2001:db8::1' }), 'x-real-ip')).toBe('2001:db8::1')
  })

  it('REJECTS a list, because the client\'s copy arrives leftmost', () => {
    // The spoof this guards: a header the edge SETS is single-valued, but Node joins duplicates with
    // ", " and the CLIENT's copy comes FIRST. On an edge that appends (or fails to strip the
    // client's), taking the leftmost entry would hand a visitor `$request->ip()` upstream — worse
    // than the shared bucket this option fixes. Refusing turns that into a visible loss of function.
    expect(visitorIp(req({ 'cf-connecting-ip': '6.6.6.6, 198.51.100.23' }), 'cf-connecting-ip')).toBe('')
    expect(visitorIp(req({ 'x-forwarded-for': '203.0.113.9, 70.0.0.1' }), 'x-forwarded-for')).toBe('')
  })

  it('rejects anything that is not an exact IP', () => {
    // The value can become an upstream rate-limit key or feed an IP allowlist, so a charset check
    // ("looks vaguely like an address") is not enough.
    for (const bad of ['deadbeef', '......', '::::', '1.2.3.4.5.6', '256.1.1.1', '1.2.3.4:80', 'fe80::1%eth0'])
      expect(visitorIp(req({ 'cf-connecting-ip': bad }), 'cf-connecting-ip')).toBe('')
    // The URL parser reads trailing junk as a path (`http://[::1]/x]` has host `[::1]`), so the
    // charset guard has to run first or `::1]/x` would sail through as an address.
    for (const bad of ['::1]/foo', '::1]?x', '::1]#x'])
      expect(visitorIp(req({ 'cf-connecting-ip': bad }), 'cf-connecting-ip')).toBe('')
  })

  it('canonicalises IPv6 so one host cannot occupy several rate-limit buckets', () => {
    const ip = (v: string) => visitorIp(req({ 'cf-connecting-ip': v }), 'cf-connecting-ip')
    // Same host, two spellings — upstream keys on the string, so they must normalise to one.
    expect(ip('2001:0db8:0000:0000:0000:0000:0000:0001')).toBe('2001:db8::1')
    expect(ip('2001:db8::1')).toBe('2001:db8::1')
    expect(ip('::ffff:127.0.0.1')).toBe('::ffff:7f00:1')
    // IPv4 is already canonical and passes through untouched.
    expect(ip('198.51.100.23')).toBe('198.51.100.23')
  })

  it('cannot be steered by a header other than the configured one', () => {
    expect(visitorIp(req({ 'x-forwarded-for': '1.2.3.4', 'cf-connecting-ip': '203.0.113.9' }), 'cf-connecting-ip')).toBe('203.0.113.9')
  })

  it('yields nothing — never the socket address — when the trusted header is absent or malformed', () => {
    // Callers that must assert something compose the socket fallback themselves; the auth paths
    // deliberately stay silent instead of handing lukk this server's address as a rate-limit key.
    expect(visitorIp(req({}), 'cf-connecting-ip')).toBe('')
    expect(visitorIp(req({ 'cf-connecting-ip': '' }), 'cf-connecting-ip')).toBe('')
    expect(visitorIp(req({ 'cf-connecting-ip': 'not an ip' }), 'cf-connecting-ip')).toBe('')
    expect(visitorIp(req({ 'cf-connecting-ip': 'a'.repeat(60) }), 'cf-connecting-ip')).toBe('')
    // Anything header-injectable is rejected outright rather than forwarded.
    expect(visitorIp(req({ 'cf-connecting-ip': '1.2.3.4\r\nX-Admin: 1' }), 'cf-connecting-ip')).toBe('')
  })
})

describe('hopByHopHeaders', () => {
  it('blanks the standard hop-by-hop set h3 does not already drop', () => {
    // h3's proxyRequest drops connection/keep-alive/upgrade/transfer-encoding; these are the rest
    // of RFC 9110 §7.6.1, plus proxy-authorization, which is credential material for this hop only.
    const blanked = hopByHopHeaders({ headers: {} } as never)

    for (const name of ['te', 'trailer', 'proxy-connection', 'proxy-authenticate', 'proxy-authorization'])
      expect(blanked[name]).toBe('')
  })

  it('blanks the fields the client named in Connection', () => {
    // The half h3 misses: it drops `Connection` itself but forwards the fields it named, so a
    // header explicitly marked single-hop reaches the upstream with the instruction to strip it gone.
    const blanked = hopByHopHeaders({ headers: { connection: 'X-Custom-Thing, x-another' } } as never)

    expect(blanked['x-custom-thing']).toBe('')
    expect(blanked['x-another']).toBe('')
  })

  it('refuses to let Connection strip a header the proxy sets itself', () => {
    // Otherwise a client could name `authorization` and have the injected bearer token removed on
    // the way through — turning a header it cannot read into one it can delete.
    const blanked = hopByHopHeaders(
      { headers: { connection: 'authorization, x-forwarded-for, x-lukk-confirmation' } } as never,
      ['authorization', 'x-forwarded-for', 'X-Lukk-Confirmation'],
    )

    expect(blanked).not.toHaveProperty('authorization')
    expect(blanked).not.toHaveProperty('x-forwarded-for')
    expect(blanked).not.toHaveProperty('x-lukk-confirmation')
  })

  it('ignores empty entries in a malformed Connection header', () => {
    // `toHaveProperty('')` can't express this — an empty path is not a valid property path.
    expect(Object.keys(hopByHopHeaders({ headers: { connection: ' , ,, ' } } as never))).not.toContain('')
  })
})

describe('viaHeader', () => {
  it('identifies this hop with a pseudonym, not the internal hostname', () => {
    // RFC 9110 §7.6.3 permits a pseudonym; the alternative leaks the BFF's hostname upstream.
    expect(viaHeader({ headers: {}, node: { req: { httpVersion: '1.1' } } } as never)).toBe('1.1 lukk-nuxt')
  })

  it('appends to an existing Via rather than replacing the chain', () => {
    expect(viaHeader({ headers: { via: '1.1 edge' }, node: { req: { httpVersion: '2.0' } } } as never))
      .toBe('1.1 edge, 2.0 lukk-nuxt')
  })

  it('falls back to 1.1 where there is no node request', () => {
    // workerd, Deno and Bun presets have no `node.req`.
    expect(viaHeader({ headers: {} } as never)).toBe('1.1 lukk-nuxt')
  })
})

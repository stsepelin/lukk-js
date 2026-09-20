import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('h3', () => ({
  getRequestHeader: (event: { headers?: Record<string, string> }, name: string) => event.headers?.[name],
  setResponseStatus: (event: { status?: number }, status: number) => { event.status = status },
}))

// eslint-disable-next-line import/first
import { hopByHopHeaders, isForeignOrigin, rejectUnresolvedTarget, reportProxyFailure, resolveTarget, SPOOFABLE_FORWARDING, viaHeader, visitorIp } from '../src/runtime/server/proxy-utils'

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
    // Exact, because both ends of the line carry weight. The path is JSON-quoted, so a `\n` inside
    // it can't forge a second log entry; and the "further rejections" notice belongs only on the
    // line that actually exhausts the budget — on every line it reads as though logging stopped at
    // the first request, which is the opposite of what happened.
    expect(String(warn.mock.calls[0]![0])).toBe('[lukk] Rejected a proxy path that escapes `baseURL`: "../admin"')
  })

  it('truncates the path it echoes into the log', () => {
    // The subpath is attacker-chosen and reachable unauthenticated, so an unbounded echo makes each
    // rejection cost whatever the caller wants it to — the same amplification the count cap below
    // exists to stop, priced per line instead of per request.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    rejectUnresolvedTarget(ev(), 'https://api.example.com/auth', '`baseURL`', `../${'a'.repeat(250)}tail`)

    const line = String(warn.mock.calls[0]![0])
    expect(line).toContain('a'.repeat(190)) // still says enough to identify the path
    expect(line).not.toContain('tail')
    expect(line.length).toBeLessThan(260)
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

  it('accepts every octet form in the LAST position too, not just the repeated first three', () => {
    // The trailing group of the IPv4 pattern is a hand-written duplicate of the one `{3}` repeats,
    // so the two can drift apart. These are the alternations only the last octet exercises: an
    // address ending in .255, .240 or .1xx is entirely ordinary, and losing one silently turns a
    // real visitor address into "no visitor known" for a sixteenth of the space at a time.
    const ip = (v: string) => visitorIp(req({ 'cf-connecting-ip': v }), 'cf-connecting-ip')

    for (const last of ['255', '250', '240', '199', '100', '99', '9', '0'])
      expect(ip(`192.0.2.${last}`)).toBe(`192.0.2.${last}`)
  })

  it('accepts the longest IPv6 literal there is, at the exact length guard', () => {
    // 45 is not an arbitrary cap: it is the longest text an IPv6 address can have — six 4-digit
    // groups, six colons and a 15-character IPv4 tail. The guard is therefore `> 45`; at `>= 45`
    // this perfectly ordinary IPv4-mapped address is thrown away as junk.
    const longest = '0000:0000:0000:0000:0000:ffff:255.255.255.255'

    expect(longest).toHaveLength(45)
    expect(visitorIp(req({ 'cf-connecting-ip': longest }), 'cf-connecting-ip')).toBe('::ffff:ffff:ffff')
  })

  it('trims the header before reading it as an address', () => {
    // A field value may arrive with optional whitespace around it (RFC 9110 §5.5), and Node hands
    // it over as sent. Untrimmed, one stray space fails both the IPv4 pattern and the charset
    // guard — so a valid address reads as no address at all, which is indistinguishable to the
    // caller from an edge that sent nothing.
    expect(visitorIp(req({ 'cf-connecting-ip': '  203.0.113.9  ' }), 'cf-connecting-ip')).toBe('203.0.113.9')
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

  it('invents nothing when there is no Connection header at all', () => {
    // An absent header has to read as an empty list. Every name in what this returns is a header
    // the proxy then sends upstream, so one spurious entry is one invented header on every request
    // that doesn't carry `Connection` — which is most non-browser traffic.
    expect(Object.keys(hopByHopHeaders({ headers: {} } as never)).sort())
      .toEqual(['proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer'])
  })

  it('never blanks a header fetch refuses to let it set', () => {
    // `Connection: keep-alive` is what every HTTP/1.1 client sends, and the stock nginx config for
    // a Nitro app sets `Connection: upgrade` unconditionally — so these names arrive here
    // routinely, not exceptionally. undici THROWS on an attempt to set one (UND_ERR_INVALID_ARG)
    // rather than ignoring it, so listing one here doesn't strip a header, it fails the entire
    // proxy fetch. They need no blanking anyway: fetch owns the connection and forwards none of
    // them whatever the inbound request said.
    for (const name of ['connection', 'keep-alive', 'upgrade', 'transfer-encoding'])
      expect(Object.keys(hopByHopHeaders({ headers: { connection: name } } as never))).not.toContain(name)
  })
})

describe('SPOOFABLE_FORWARDING', () => {
  it('blanks every header it names — it never sets one', () => {
    // Driven from the map itself so the assertion cannot drift from the list the proxy actually
    // spreads (api-proxy.test.ts pins that the spread reaches `proxyRequest`). Every value has to
    // be the EMPTY string, and both other options are wrong in opposite directions: a missing key
    // leaves the browser's own value in place (`proxyRequest` merges this bag OVER the inbound
    // headers), and a non-empty one doesn't neutralise the client's claim — it forwards an address
    // of our choosing as the visitor's, which is the exact outcome the list exists to prevent.
    for (const [name, value] of Object.entries(SPOOFABLE_FORWARDING)) expect(value, name).toBe('')
  })

  it('names them in lower case, which is the only thing that makes the merge an override', () => {
    // h3's `getProxyRequestHeaders` lower-cases the inbound names before this bag is merged over
    // them. `X-Real-IP: ''` would therefore not blank `x-real-ip`: it would add a second, empty
    // entry and forward the client's original untouched — a silent failure, and only in the
    // direction that matters.
    for (const name of Object.keys(SPOOFABLE_FORWARDING)) expect(name).toBe(name.toLowerCase())
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

  it('trims what it received, so the chain it hands upstream stays well-formed', () => {
    // An intermediary's `Via` arrives with whatever OWS it was sent with. Appended untrimmed it
    // yields ` 1.1 edge , 1.1 lukk-nuxt`, and a whitespace-only value is worse than useless: it
    // reads as truthy, so an empty chain becomes a leading empty element.
    expect(viaHeader({ headers: { via: '  1.1 edge  ' } } as never)).toBe('1.1 edge, 1.1 lukk-nuxt')
    expect(viaHeader({ headers: { via: '   ' } } as never)).toBe('1.1 lukk-nuxt')
  })
})

describe('isForeignOrigin', () => {
  const post = (headers: Record<string, string>, secure = true) =>
    isForeignOrigin({ method: 'POST', headers } as never, secure)

  it('compares the scheme against cookieSecure, not against the transport', () => {
    // NOT inferred from the socket. TLS almost always terminates at a proxy, so the socket Nitro
    // sees is plain either way — and in Node a plain-HTTP socket has no `encrypted` property at
    // all, so socket introspection answers identically for a production request and for `nuxi dev`
    // over http. Getting that backwards 403s every non-GET in dev.
    expect(post({ origin: 'https://app.test', host: 'app.test' })).toBe(false)
    expect(post({ origin: 'http://app.test', host: 'app.test' })).toBe(true)
  })

  it('accepts an http origin when the session cookie is not Secure (dev over plain http)', () => {
    // With `cookieSecure: false` there is no scheme to insist on — and this is the exact
    // configuration `nuxi dev` produces, where a wrong answer breaks login for everyone.
    expect(post({ origin: 'http://localhost:3000', host: 'localhost:3000' }, false)).toBe(false)
    expect(post({ origin: 'https://localhost:3000', host: 'localhost:3000' }, false)).toBe(false)
    // The host still has to match.
    expect(post({ origin: 'http://evil.test', host: 'localhost:3000' }, false)).toBe(true)
  })

  it('treats a browser-declared cross-site or same-site request as foreign', () => {
    // Sent by every browser and by no other client, so when present it is decisive. `same-site` is
    // a different subdomain — still not us, and the `__Host-` cookie is host-locked anyway.
    expect(post({ 'sec-fetch-site': 'cross-site', 'origin': 'https://app.test', 'host': 'app.test' })).toBe(true)
    expect(post({ 'sec-fetch-site': 'same-site', 'origin': 'https://app.test', 'host': 'app.test' })).toBe(true)
    expect(post({ 'sec-fetch-site': 'same-origin', 'origin': 'https://app.test', 'host': 'app.test' })).toBe(false)
  })

  it('leaves a non-browser caller alone, and never gates a safe method', () => {
    // No Origin on a non-GET means no browser, hence no sealed cookie to ride. SameSite=Strict is
    // the primary layer; this is the second.
    expect(post({ host: 'app.test' })).toBe(false)
    expect(isForeignOrigin({ method: 'GET', headers: { origin: 'https://evil.test' } } as never)).toBe(false)
    // HEAD is safe too (RFC 9110 §9.3.2) and h3 routes it to the same handler as GET, so gating it
    // would 403 every cross-site prefetch/conditional probe of a route that is readable anyway.
    expect(isForeignOrigin({ method: 'HEAD', headers: { origin: 'https://evil.test', host: 'app.test' } } as never)).toBe(false)
  })

  it('insists on https by DEFAULT, so a call site that forgets the flag fails closed', () => {
    // Every current caller passes `cookieSecure` explicitly; the default still has to be the
    // strict answer, because the one that doesn't is the one that silently accepts a downgraded
    // Origin in production.
    expect(isForeignOrigin({ method: 'POST', headers: { origin: 'http://app.test', host: 'app.test' } } as never)).toBe(true)
  })

  it('rejects an unparseable Origin', () => {
    expect(post({ origin: 'not a url', host: 'app.test' })).toBe(true)
  })
})

describe('reportProxyFailure', () => {
  // A fresh copy of the module: the log budget is per process and the cap test at the end of this
  // block spends all of it, so anything that asserts on a log line has to start from its own zero
  // rather than depend on running first.
  const fresh = async () => {
    vi.resetModules()
    return (await import('../src/runtime/server/proxy-utils')).reportProxyFailure
  }

  it('survives an error carrying no cause, and says so plainly', async () => {
    // What h3 rejected with is whatever the fetch threw — a non-Error value, or nothing at all on
    // an aborted request — so every hop down to `.cause.message` has to be optional. A TypeError
    // raised here would replace the 502 the caller is in the middle of reporting with a crash
    // inside the logger, which is the one place that must not fail.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const report = await fresh()

    expect(() => report('https://api.test/users', undefined)).not.toThrow()
    // Exact: nothing trails the target when there is no cause to name, and the "further failures"
    // notice belongs to the line that exhausts the budget — twenty distinct failures away.
    expect(String(error.mock.calls[0]![0])).toBe('[lukk] app-API proxy failed for https://api.test/users')
  })

  it('treats an empty cause as no cause, in the dedup key as well as in the line', async () => {
    // Both render a byte-identical message, so keying them apart logs the same line twice for what
    // an operator reads as one failure — and an upstream that alternates between the two defeats
    // the dedup completely, which is the amplification this Set exists to stop.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const report = await fresh()

    report('https://api.test/users', new Error('unreachable'))
    report('https://api.test/users', Object.assign(new Error('unreachable'), { cause: { message: '' } }))

    expect(error).toHaveBeenCalledOnce()
  })

  // Last in the block on purpose: it spends the whole per-process budget, so anything added after
  // it would see a logger that has already gone quiet.
  it('caps the number of distinct failures it will ever log', async () => {
    // The dedup key includes the cause, so a cause embedding something variable (a request id, a
    // timestamp) would grow the Set without bound — the same log amplification in a different
    // costume, plus a slow leak. The last line it emits says it has stopped.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    for (let i = 0; i < 30; i++) {
      reportProxyFailure('https://api.test', Object.assign(new Error('x'), { cause: { message: `distinct-${i}` } }))
    }

    expect(error).toHaveBeenCalledTimes(20)
    expect(String(error.mock.calls[19]![0])).toContain('further proxy failures will not be logged')
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('h3', () => ({
  getRequestHeader: (event: { headers?: Record<string, string> }, name: string) => event.headers?.[name],
  setResponseStatus: (event: { status?: number }, status: number) => { event.status = status },
}))

// eslint-disable-next-line import/first
import { fetchUpstream, hopByHopHeaders, isForeignOrigin, isForeignSubresource, reachesLukk, rejectUnresolvedTarget, reportProxyFailure, resolveTarget, routeWithin, SPOOFABLE_FORWARDING, viaHeader, visitorIp } from '../src/runtime/server/proxy-utils'

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

  it('keeps a decoded `?` or `#` in the subpath as path data', () => {
    // The subpath arrives DECODED, so these were `%3F` / `%23` on the wire. Left bare, the parser made
    // them a query or fragment, and the upstream received a different path than policy had looked at.
    expect(resolveTarget('https://api.example.com/auth', '/refresh#x')).toBe('https://api.example.com/auth/refresh%23x')
    expect(resolveTarget('https://api.example.com/auth', '/a?b?c#d')).toBe('https://api.example.com/auth/a%3Fb%3Fc%23d')
  })

  it('keeps containment for a sibling path that merely shares a prefix', () => {
    expect(resolveTarget('https://api.example.com/auth', '../auth2/x')).toBeNull()
  })
})

describe('routeWithin', () => {
  it('reads repeated slashes the way a slash-merging hop delivers them', () => {
    // Laravel alone never routes `//auth/login`, but nginx (`merge_slashes on`, the default) or an
    // ingress in front of it hands lukk `/auth/login`. Read as distinct, `/api//auth/login` slipped past
    // the app-API proxy's refusal and `/_lukk//refresh` past the BFF's never-proxy-refresh rule.
    expect(routeWithin('https://l.test//auth/login', 'https://l.test/auth')).toBe('/login')
    expect(routeWithin('https://l.test/auth//refresh', 'https://l.test/auth')).toBe('/refresh')
    expect(routeWithin('https://l.test/auth/%2F%2Frefresh', 'https://l.test/auth')).toBe('/refresh')
    expect(routeWithin('https://l.test/auth///', 'https://l.test/auth')).toBe('/')
  })

  // What lukk's router will match, not what the URL string looks like: Laravel trims trailing slashes
  // from the raw path and then `rawurldecode`s it (Illuminate\\Routing\\Matching\\UriValidator).
  it.each([
    ['https://l.test/auth/refresh', '/refresh'],
    ['https://l.test/auth/refresh/', '/refresh'],
    ['https://l.test/auth/refresh//', '/refresh'],
    ['https://l.test/auth/refresh%2F', '/refresh/'], // trimmed BEFORE decoding, as Laravel does
    ['https://l.test/auth%2Frefresh', '/refresh'],
    ['https://l.test/auth/refres%68', '/refresh'],
    ['https://l.test/auth/refres%6A', '/refresj'], // upper-case hex too
    ['https://l.test/auth/caf%C3%A9', '/caf%C3%A9'], // non-ASCII escapes stay as they are
    ['https://l.test/auth/%7Ftail', '/\u007Ftail'], // the top of the ASCII range is decoded
    ['https://l.test/auth/%80tail', '/%80tail'], // and the byte after it is not
    ['https://l.test/auth', '/'],
    ['https://l.test/auth/', '/'],
  ])('%s is %s to lukk', (target, route) => {
    expect(routeWithin(target, 'https://l.test/auth')).toBe(route)
  })

  it('trims the base the same way', () => {
    expect(routeWithin('https://l.test/auth/login', 'https://l.test/auth/')).toBe('/login')
    expect(routeWithin('https://l.test/auth/login', 'https://l.test/aut%68')).toBe('/login')
  })

  it('is null for a path that only shares the prefix, or lies outside', () => {
    expect(routeWithin('https://l.test/authors', 'https://l.test/auth')).toBeNull()
    expect(routeWithin('https://l.test/users', 'https://l.test/auth')).toBeNull()
  })

  it('places everything under a root base', () => {
    expect(routeWithin('https://l.test/login', 'https://l.test')).toBe('/login')
    expect(routeWithin('https://l.test/', 'https://l.test/')).toBe('/')
  })
})

describe('reachesLukk', () => {
  it('decides a non-root base on the path, whatever the host', () => {
    expect(reachesLukk('https://api.test/auth/login', 'https://api.test/auth')).toBe(true)
    expect(reachesLukk('https://api.test/auth/login', 'http://internal:8000/auth')).toBe(true)
    expect(reachesLukk('https://api.test/Auth/LOGIN', 'https://api.test/auth')).toBe(true)
    expect(reachesLukk('https://api.test/auth/login', 'https://api.test/AUTH')).toBe(true)
    expect(reachesLukk('https://api.test/authors', 'https://api.test/auth')).toBe(false)
  })

  it.each(['/index.php/auth/login', '/INDEX.PHP/auth/refresh', '/app.php/auth', '/index%2Ephp/auth/login', '/index.php/index.php/auth/login'])('sees through a PHP front controller: %s reaches lukk', (path) => {
    // Laravel served through its front controller routes `/index.php/auth/login` exactly as `/auth/login`
    // (Symfony strips the script name), so with `api.target` at the app root it streamed the token pair out.
    expect(reachesLukk(`https://api.test${path}`, 'https://api.test/auth')).toBe(true)
  })

  it.each([
    ['https://h.test/app/index.php/auth/login', 'https://h.test/app/auth'],
    ['https://h.test/api/index.php/auth/login', 'https://h.test/api/auth'],
    ['https://h.test/app/x/index.php/auth/login', 'https://h.test/app/x/auth'],
  ])('sees through a front controller under a sub-path too: %s', (target, base) => {
    // Laravel under `/app` routes `/app/index.php/auth/login` as `/app/auth/login`: the script can be any
    // segment, not only the first.
    expect(reachesLukk(target, base)).toBe(true)
  })

  it.each([
    ['https://h.test/index.php/auth/login', 'https://h.test/index.php/auth'],
    ['https://h.test/auth/login', 'https://h.test/index.php/auth'],
    ['https://h.test/app/index.php/auth/login', 'https://h.test/app/index.php/auth'],
  ])('sees a base that names the front controller itself (Laravel without rewriting): %s', (target, base) => {
    // `baseURL` at `https://h/index.php/auth`, `api.target` at `https://h`: judged with the script dropped from
    // the target alone, `/api/index.php/auth/login` read as `/auth/login` against `/index.php/auth` and passed.
    expect(reachesLukk(target, base)).toBe(true)
  })

  it.each([
    '/auth%2Flogin%3F.php',
    '/auth%2Flogin%23.php',
    '/auth%252Flogin%253F.php',
    '/auth%253Flogin.php',
    '/%2561uth%252Flogin%253F.php',
    '/x%2F..%2Fauth%2Flogin%3F.php',
    '/files/a%2F..%2Fb.php',
    '/..%2Fx.php',
    '/a%5c..%5cb.php',
  ])('never drops a .php segment that hides a separator or a dot segment before judging it: %s', (path) => {
    // Dropped whole, the segment took its encoded `/`, `?`, `#` or `..` with it — and the path that decodes to
    // lukk's route, or traverses, was never looked at.
    expect(reachesLukk(`https://api.test${path}`, 'https://api.test/auth')).toBe(true)
  })

  it('lets an app\'s own routes behind a front controller, and .php names elsewhere, through', () => {
    expect(reachesLukk('https://api.test/index.php/users', 'https://api.test/auth')).toBe(false)
    expect(reachesLukk('https://api.test/files/report.php', 'https://api.test/auth')).toBe(false)
    expect(reachesLukk('https://api.test/index.php', 'https://api.test/auth')).toBe(false)
    expect(reachesLukk('https://api.test/index.phpx/auth/login', 'https://api.test/auth')).toBe(false) // not a .php script
  })

  it('decides a root base on the origin', () => {
    expect(reachesLukk('https://api.test/users', 'https://api.test')).toBe(true)
    expect(reachesLukk('https://API.test/users', 'https://api.test/')).toBe(true)
    expect(reachesLukk('https://api.test/users', 'https://auth.test')).toBe(false)
  })

  it('follows the path through further rounds of decoding, collapsing the dot segments each one produces', () => {
    const base = 'https://api.test/auth'
    expect(reachesLukk('https://api.test/x/%252e%252e/auth/login', base)).toBe(true) // ../ after one more round
    expect(reachesLukk('https://api.test/%2561uth/login', base)).toBe(true) // /auth after one more round
    expect(reachesLukk('https://api.test/x/%2525252e%2525252e/auth/login', base)).toBe(true) // the third round
    // A leading `//` a round produces stays a path on the TARGET's host — it is not read as an authority.
    expect(reachesLukk('https://api.test/%252f%252fauth.test/auth/login', 'https://auth.test')).toBe(false)
  })

  it.each(['my%20file.pdf', '%7Bid%7D', 'a%22b', '%3Cx%3E', 'a%5Eb', 'a%60b', 'a%7Fb'])('lets /files/%s through — an escape the parser puts straight back is settled, not still decoding', (name) => {
    // `new URL` re-encodes these after a round decodes them, so the decoded STRING never equals the parsed
    // path. Compared that way the path never settled, ran out of rounds and was refused: every download
    // with a space in its name answered 404.
    expect(reachesLukk(`https://api.test/files/${name}`, 'https://api.test/auth')).toBe(false)
  })

  it('refuses nothing on this host when lukk is mounted at the root of ANOTHER one, whatever the encoding', () => {
    expect(reachesLukk('https://api.test/files/my%20file.pdf', 'https://auth.test')).toBe(false)
    expect(reachesLukk('https://api.test/x/%252e%252e/login', 'https://auth.test/')).toBe(false)
  })

  it.each([
    '/api/x%3F/%252e%252e/auth/login', // `%3F` decodes to `?`, which a re-parse would read as the query
    '/api/x%23/%252e%252e/auth/login', // `#` likewise, as the fragment
    '/api/x%253F/%25252e%25252e/auth/login', // and the same one round later
  ])('follows %s past a decoded `?` or `#` — a hop that decodes it may well keep it in the path', (path) => {
    // Re-parsed, the path was cut at the decoded `?`/`#`, so the dot segments after it never collapsed and
    // the route lukk would see behind such a hop was never looked at. Both readings are checked now.
    expect(reachesLukk(`https://api.test${path.slice('/api'.length)}`, 'https://api.test/auth')).toBe(true)
  })

  it('checks each reading on its own: as lukk routes it now, and cut at a `?` a further round decodes', () => {
    const base = 'https://api.test/auth'
    // Under lukk's base as lukk itself decodes it, even though one more round would walk it back out.
    expect(reachesLukk('https://api.test/auth/%252e%252e/x', base)).toBe(true)
    // Only a hop that decodes twice and cuts at the `?` lands on lukk's base — the encoded reading settles.
    expect(reachesLukk('https://api.test/auth%253Flogin', base)).toBe(true)
  })

  it.each([
    '/x//%252e%252e/auth/login', // a slash-merging hop, then a decoding one
    '/login/%25252e%25252e/%252e%252e/auth/login', // dot segments decoding at different depths
    '/x/%252e/../%252e%252e%255cauth/login', // a backslash a decoding round reveals
    '/x/%252E%252E/y', // whatever it would reach — the case of the escape does not matter
    '/x/%252e/y', // a lone `.` too
    // A tab, LF or CR a round reveals: the URL parser strips them anywhere before it collapses dots.
    '/x//%252e%252e%2509/auth/login',
    '/x//%252e%252e%250a/auth/login',
    '/x//%252e%252e%250d/auth/login',
    '/x//%252e%2509%252e/auth/login',
    '/x//%2509%252e%252e/auth/login',
    '/x//.%2509./auth/login',
    // A backslash a round reveals, after merged slashes — only the split on `\` sees this one.
    '/x//%252e%252e%255cauth/login',
  ])('refuses %s: a decoding round reveals a dot segment, and no chain of hops is simulated to see where it lands', (path) => {
    // Simulating hops misses chains — merge slashes, then decode, then collapse — so a `.` or `..` segment
    // that only DECODING reveals is refused outright: no app path is written that way on purpose.
    expect(reachesLukk(`https://api.test${path}`, 'https://api.test/auth')).toBe(true)
  })

  it.each(['/files/a%2F..%2Fb', '/files/foo%2F.%2Fbar.txt', '/..%2Fx', '/a%5c..%5cb'])('refuses %s: a dot segment hidden behind an encoded slash is traversal-shaped too', (path) => {
    // h3 leaves `%2F` encoded, so the URL parser sees one segment — but any hop that decodes once sees `..`.
    expect(reachesLukk(`https://api.test${path}`, 'https://api.test/auth')).toBe(true)
  })

  it('refuses a revealed dot segment for a non-root lukk on another host too — the path decides there', () => {
    expect(reachesLukk('https://api.test/x/%252e%252e/y', 'http://internal:8000/auth')).toBe(true)
  })

  it.each(['/search%3Fq', '/files/my%20file.pdf', '/x%2520', '/a;b', '/q/%23tag', '/authors', '//x', '/a%253Fb', '/v1.2/x', '/file.tar.gz', '/.well-known/x', '/x/..y', '/x/.../y', '/x/%252e%252ey'])('lets %s through: no decoding round reveals a whole `.` or `..` segment', (path) => {
    expect(reachesLukk(`https://api.test${path}`, 'https://api.test/auth')).toBe(false)
  })

  it('still follows a decoding round to a control character, or to a backslash the parser reads as a slash', () => {
    const base = 'https://api.test/auth'
    expect(reachesLukk('https://api.test/x%255c..%255cauth/login', base)).toBe(true)
    expect(reachesLukk('https://api.test/auth%2509/login', base)).toBe(true)
  })

  it('lets an app path through once decoding settles, and refuses one still decoding after four rounds', () => {
    const base = 'https://api.test/auth'
    // Settles on the fourth look (`/x%252541` → `/x%2541` → `/x%41` → `/xA`), never under /auth.
    expect(reachesLukk('https://api.test/x%252541', base)).toBe(false)
    // One level deeper is still changing when the rounds run out: no telling where the next lands.
    expect(reachesLukk('https://api.test/x%25252541', base)).toBe(true)
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
    expect(body.message).toContain('check the `baseURL` configuration')
    expect(body.message).not.toContain('undefined/auth')
    expect(error).toHaveBeenCalledOnce()
    expect(String(error.mock.calls[0]![0])).toContain('undefined/auth')
    // Named by the setting at fault: the app-API proxy reports its own.
    expect(rejectUnresolvedTarget(ev(), 'undefined/api', 'lukk `api.target`', '/x').message).toContain('check the lukk `api.target` configuration')
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

describe('isForeignSubresource', () => {
  const event = (method: string, headers: Record<string, string>) => ({ method, headers }) as never

  it('names a GET or HEAD from another site or a same-site sibling that is not a navigation', () => {
    expect(isForeignSubresource(event('GET', { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'no-cors' }))).toBe(true)
    expect(isForeignSubresource(event('HEAD', { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors' }))).toBe(true)
  })

  it('names a NESTED navigation too — only a top-level document is a link the visitor followed', () => {
    // `Sec-Fetch-Mode: navigate` is also sent for an iframe, frame, embed or object; only
    // `Sec-Fetch-Dest: document` is a top-level navigation.
    for (const dest of ['iframe', 'frame', 'embed', 'object', '']) {
      expect(isForeignSubresource(event('GET', { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': dest })), dest).toBe(true)
    }
    expect(isForeignSubresource(event('GET', { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'navigate' }))).toBe(true)
  })

  it('leaves alone a top-level navigation, the app\'s own requests, a caller with no fetch metadata, and other methods', () => {
    expect(isForeignSubresource(event('GET', { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }))).toBe(false)
    expect(isForeignSubresource(event('GET', { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' }))).toBe(false)
    expect(isForeignSubresource(event('GET', {}))).toBe(false)
    // Another method is the origin check's to judge.
    expect(isForeignSubresource(event('POST', { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'no-cors' }))).toBe(false)
  })
})

describe('fetchUpstream', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

  /** A response whose headers arrive at once and whose body never does — unless the call is aborted. */
  const stalledBody = (signal?: AbortSignal | null) => new Response(new ReadableStream({
    start(controller) { signal?.addEventListener('abort', () => controller.error(signal.reason)) },
  }), { status: 200 })

  it('abandons a call lukk never answers, saying why', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))
    }))

    const call = fetchUpstream('https://lukk.test/auth/logout', { method: 'POST' }, res => res.text())
    const failed = expect(call).rejects.toThrow('lukk did not answer within 15000 ms')
    await vi.advanceTimersByTimeAsync(15_000)
    await failed
  })

  it('holds the deadline over the body too, not only the headers', async () => {
    // A server that sends its headers and then stalls the body otherwise hung the caller for as long as
    // the runtime's own socket timeout allowed — the very wait the deadline exists to bound.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => stalledBody(init?.signal))

    const call = fetchUpstream('https://lukk.test/auth/user', { method: 'GET' }, res => res.text())
    const failed = expect(call).rejects.toThrow('lukk did not answer within 15000 ms')
    await vi.advanceTimersByTimeAsync(15_000)
    await failed
  })

  it('hands back what the reader read, and leaves no timer behind once it has', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"ok":true}', { status: 200 }))

    await expect(fetchUpstream('https://lukk.test/auth/logout', { method: 'POST' }, res => res.text())).resolves.toBe('{"ok":true}')

    expect(vi.getTimerCount()).toBe(0)
  })
})

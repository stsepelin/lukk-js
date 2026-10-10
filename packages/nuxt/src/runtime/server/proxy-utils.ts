import type { H3Event } from 'h3'
import { getRequestHeader, setResponseStatus } from 'h3'
import { isResolvableBase, redactCredentials } from '../shared'

/**
 * Build an upstream URL contained to `base` — same origin AND under its path
 * prefix. The origin is baked into `prefix`, so a cross-origin or traversal
 * target (including encoded `%2e%2e`, which `new URL` normalizes) fails the one
 * `startsWith` check. `base` is always FIXED server config, never request-derived,
 * so this is the SSRF / open-proxy guard for both proxies.
 *
 * Returns null for BOTH an unusable base and an escaping subpath — very different faults, so
 * callers report them via `rejectUnresolvedTarget` rather than collapsing them into one message.
 *
 * `subpath` is a DECODED path — h3's `event.path` has already decoded every escape except `%2F` and
 * `%25` by the time a handler sees it. So `..%2f` reaches here with the `%2f` intact and stays literal
 * (the URL spec does not read it as a dot-segment), and `%252e%252e` reaches here as `%252e%252e` and
 * is forwarded as such; but `%2e%2e` has become `..` and is normalized away like any other. Either
 * way the result is same-origin and under the base. An upstream that decodes a second time owns that
 * decision — don't read this as full path normalization on lukk's behalf.
 *
 * Because it is decoded, a `?` or `#` in it was data in a path segment (`%3F`, `%23` on the wire), and
 * is re-encoded here: left bare, the URL parser made it the start of a query or fragment, so the
 * upstream received a different path than the one the policy above it had looked at.
 */
export function resolveTarget(base: string, subpath: string): string | null {
  // Reject a non-http(s) base up front. Its origin serializes to `"null"`, so the containment check
  // below degrades to a bare string-prefix test, and an opaque path (`data:`) is never dot-
  // normalized — weak rather than directly exploitable, but there's no reason to carry it.
  //
  // It also makes the rest total: resolving any string against a valid absolute base cannot throw
  // (every attacker byte lands in path/query/fragment state, which has no parse failures), so a
  // null from here on means exactly one thing — the subpath escaped.
  if (!isResolvableBase(base)) return null
  const b = new URL(base)
  // Build from the PARSED base, not the raw config string. Two faults would otherwise survive the
  // build gate and then reject every request as a bogus traversal: surrounding whitespace (the URL
  // parser trims it, the raw slice doesn't → `/auth%20/login`), and a query/fragment on the base
  // (`/auth?t=1` + `/login` → `/auth?t=1/login`, which swallows the path into the query while
  // still passing containment — so every route silently hits the same upstream endpoint).
  b.search = ''
  b.hash = ''
  const prefix = `${b.origin}${b.pathname.replace(/\/$/, '')}/`
  const target = new URL(`${b.href.replace(/\/$/, '')}/${subpath.replace(/^\//, '').replace(/[?#]/g, encodeURIComponent)}`)
  if (!`${target.origin}${target.pathname}/`.startsWith(prefix)) return null
  return target.toString()
}

/**
 * The path a Laravel router matches for `pathname`, the way `UriValidator` derives it: trailing
 * slashes trimmed from the raw path, THEN percent-decoded once (`rawurldecode`). So `/auth/`,
 * `/auth%2Flogin` and `/aut%68` are `/auth`, `/auth/login` and `/auth` to lukk, whatever they look
 * like as URLs.
 *
 * Only ASCII escapes are decoded: every route literal compared against this is ASCII, and an escape
 * of a non-ASCII byte can only ever produce a non-ASCII character, which no such literal contains.
 * That keeps it total — `decodeURIComponent` throws on a malformed sequence, `rawurldecode` doesn't.
 */
function routedPath(pathname: string): string {
  // Repeated slashes collapse too, last: Laravel alone never routes `//auth/login`, but a hop in front of
  // it that merges slashes (nginx's default `merge_slashes on`) hands it `/auth/login`. Reading them as
  // distinct let `/api//auth/login` past the app-API proxy and `/_lukk//refresh` past the refresh rule.
  return decodeAscii(pathname.replace(/\/+$/, '')).replace(/\/{2,}/g, '/')
}

/** One round of percent-decoding, ASCII escapes only — see `routedPath` for why that is enough. */
function decodeAscii(value: string): string {
  return value.replace(/%([0-7][0-9a-f])/gi, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
}

/**
 * Where `target` lands within `base` AS LUKK'S ROUTER SEES IT (`/refresh`, `/login`, ...), or null
 * when it is not under `base` at all. Both must be absolute http(s) URLs.
 *
 * Route policy must be decided on THIS, never on the request path it came from: the upstream URL
 * collapses dot segments and drops a fragment, and Laravel trims a trailing slash and decodes the
 * rest, so `/./refresh`, `/refresh/` and `/refresh%2F` (among others) all reach lukk's refresh route
 * while comparing unequal to `'/refresh'` as strings.
 */
export function routeWithin(target: string, base: string): string | null {
  const root = routedPath(new URL(base).pathname)
  const path = routedPath(new URL(target).pathname)
  if (path !== root && !path.startsWith(`${root}/`)) return null
  return path.slice(root.length) || '/'
}

/**
 * Whether an upstream URL the app-API proxy built would reach one of lukk's own routes.
 *
 * Those routes answer with credentials — a token pair, a step-up token — and the app-API proxy
 * streams bodies through untouched, so reaching one hands the browser exactly what BFF mode keeps
 * from it. Under a non-root base the PATH decides, whatever the host: the same Laravel app is
 * routinely reached under two names (a public one for `api.target`, an internal one for `baseURL`),
 * and an origin comparison waves the token routes through exactly there. Case-insensitively — Laravel
 * matches case-sensitively, so this costs nothing, and it doesn't depend on that staying true.
 *
 * A lukk mounted at the ROOT owns every path, so only the origin can tell its routes apart: on its
 * own host everything is refused; on another host nothing is (lukk bound to a separate domain).
 */
export function reachesLukk(target: string, base: string): boolean {
  if (reaches(target, base)) return true
  // Read through any PHP front controller as well. Laravel served through one routes `/index.php/auth/login`
  // exactly as `/auth/login` — Symfony strips the script name — so with `api.target` at the app's root that
  // path streamed lukk's token pair out; under a sub-path the script sits further in (`/app/index.php/auth/…`),
  // and without URL rewriting `baseURL` names it too (`https://h/index.php/auth`). So both are judged again
  // with every segment naming a `.php` script dropped — AS WELL AS, never instead of, as written above:
  // dropped whole, a segment takes what it hides with it (`/auth%2Flogin%3F.php`).
  //
  // On every round of decoding, as `reaches` judges the path itself: a hop that decodes once more turns
  // `/index.php%2Fauth/login` into `/index.php/auth/login` and `/index%252ephp/…` into `/index%2ephp/…`,
  // which Symfony reads as the script. So each round's string is split on `/` and `\` (as a decoding hop
  // treats them alike), its scripts dropped, and the rest judged — a `?` or `#` it decoded kept encoded,
  // so that `reaches` reads it both ways.
  const lukk = withoutScripts(base)
  const { origin, pathname } = new URL(target)
  let path = pathname
  // Stryker disable next-line EqualityOperator: equivalent — a script only a fifth decoding reveals sits in a path still decoding after four rounds, which `reaches` refuses above, as written. (`round--` never ends: that timeout is a synchronous loop, the detection.)
  for (let round = 0; round < DECODING_ROUNDS; round++) {
    const rest = path.split(/[/\\]/).filter(segment => !/\.php$/i.test(segment)).join('/').replace(/[?#]/g, encodeURIComponent)
    if (reaches(`${origin}${rest}`, lukk)) return true
    path = decodeAscii(path)
  }
  return false
}

/** `url` with every path segment that names a `.php` script dropped. */
function withoutScripts(url: string): string {
  const { origin, pathname } = new URL(url)
  return `${origin}${pathname.split('/').filter(segment => !/\.php$/i.test(decodeAscii(segment))).join('/')}`
}

/** `reachesLukk` for one reading of the path — the front controller aside. */
function reaches(target: string, base: string): boolean {
  const b = new URL(base.toLowerCase())
  let t = new URL(target.toLowerCase())

  // And not after a further decoding, either. The URL is forwarded as written, and lukk's router decodes
  // it once — but a hop in between that decodes again (a CDN, a rewrite rule, a second proxy) turns
  // `%252e%252e/auth/login` into `../auth/login` and `%2561uth/login` into `/auth/login`. So each round
  // of decoding is checked as well, re-parsed so that a dot segment it produced collapses as it would
  // there. Re-parsed under the TARGET's origin, so a leading `//` it produced stays a path.
  //
  // Settled is judged on the RE-PARSED path, never on the decoded string: the parser puts some escapes
  // straight back (`%20`, `%22`, `%3C`, `%7B`, … — characters a path may not hold bare), so the string a
  // round produced never equals the path it parses to. Compared that way, `my%20file.pdf` never settled
  // and every download with a space in its name was refused. What the parser REMOVES or rewrites — a tab,
  // a backslash that becomes `/` — still changes the path, and is still followed.
  //
  // A `?` or `#` a round decodes is read two ways, and both are checked: a hop that decodes and re-parses
  // cuts the path there, and one that decodes and forwards the string keeps it as path data — where the
  // dot segments after it still collapse. Reading only the first let `x%3F/%252e%252e/auth/login` through.
  //
  // And simulating hops has a limit: a CHAIN of them — merge slashes, then decode, then collapse — lands
  // where no single reading here does (`/x//%252e%252e/auth/login`). So a `.` or `..` segment that only
  // decoding reveals is refused outright, wherever it would land. The URL parser has already collapsed every
  // one written plainly or as `%2e`; what remains was either encoded twice, or sits behind an ENCODED
  // separator (`a%2F..%2Fb`, `a%5c..%5cb` — h3 leaves `%2F` encoded, so the parser saw one segment). Both
  // are traversal-shaped, and no app path is written that way on purpose. Unless the path cannot matter — lukk at the ROOT owns every path or none: of its own host
  // the loop below refuses everything anyway, and of another host nothing here reaches it.
  if (routedPath(b.pathname) !== '' && revealsDotSegment(t.pathname)) return true
  const lands = (url: URL) => routeWithin(url.href, b.href) !== null && (routedPath(b.pathname) !== '' || url.origin === b.origin)
  for (let round = 0; round < DECODING_ROUNDS; round++) {
    // lukk's own reading. Defence in depth since the dot-segment refusal above: whatever it catches, the cut
    // reading below catches too — that one decodes once more, which never strips a decoded `/auth/` prefix,
    // and the dot segments that could are refused above.
    // Stryker disable next-line ConditionalExpression: equivalent, for the reason just given.
    if (lands(t)) return true
    const decoded = decodeAscii(t.pathname)
    if (lands(new URL(`${t.origin}${decoded}`))) return true
    const next = new URL(`${t.origin}${decoded.replace(/[?#]/g, encodeURIComponent)}`)
    if (next.pathname === t.pathname) return false
    t = next
  }

  // Still decoding to something new after that many rounds: no route of an app is encoded that deep on
  // purpose, and there is no telling where the next round lands — refused.
  return true
}

/** How many rounds of percent-decoding `reachesLukk` follows a path through. */
const DECODING_ROUNDS = 4

/**
 * Whether some round of decoding `pathname` turns a whole segment into `.` or `..` — split on `/` and `\`,
 * which every decoding hop worth worrying about treats alike. A dot inside a segment (`v1.2`, `.well-known`,
 * `..y`) is a name, not a step.
 */
function revealsDotSegment(pathname: string): boolean {
  let path = pathname
  // Stryker disable next-line EqualityOperator: equivalent — a fifth round only reveals a dot in a segment still decoding after four, which keeps `reachesLukk`'s own loop changing too, and its cap refuses that path anyway. (`round--` never ends: that timeout is a synchronous loop, the detection.)
  for (let round = 0; round < DECODING_ROUNDS; round++) {
    path = decodeAscii(path)
    // Without the tab, LF and CR the URL parser strips from anywhere in a URL before it collapses dots —
    // `.%09.` is `..` to every hop that re-parses. (Stripped from what is SPLIT only, so the next round
    // still decodes what was actually there.)
    if (path.replace(/[\t\n\r]/g, '').split(/[/\\]/).some(segment => segment === '.' || segment === '..')) return true
  }
  return false
}

/** Bases already reported, so a broken deploy logs once per value instead of once per request. */
const reportedBases = new Set<string>()

/**
 * Report an unusable proxy base ONCE per value, with any `user:pass@` masked.
 *
 * Both are load-bearing. The base is fixed server config, so the message is identical on every
 * request — logging per request lets a broken deploy (or an unauthenticated caller) drown the log.
 * And an *unusable* base can still carry credentials: `https://u:pw@host:99999/auth` fails on the
 * port and `ftp://u:pw@host/auth` on the scheme, so the raw value must never reach a log.
 *
 * Shared by every path that resolves an upstream URL, so they can't drift on either property.
 */
export function reportUnusableBase(label: string, base: string): void {
  if (reportedBases.has(base)) return
  reportedBases.add(base)
  console.error(`[lukk] ${label} is not an absolute http(s) URL (got ${JSON.stringify(redactCredentials(base))}) — cannot resolve the upstream URL. Check the build-time environment variables for this deploy.`)
}

/**
 * Proxy failures already reported, keyed on target + cause, plus a cap on distinct keys.
 *
 * An upstream outage fails EVERY request with the same cause, so logging per request turns a
 * downstream problem into a log-cost problem and buries whatever else is happening. Keying on the
 * cause rather than suppressing outright means a *different* failure still surfaces — the point of
 * the message is to distinguish "can't reach the upstream" from "built an illegal request", and a
 * blanket once-per-process would hide the second behind the first.
 *
 * The cap bounds the Set itself: a cause that embeds something variable would otherwise grow it
 * without limit, which is the same amplification in a different costume.
 */
const reportedProxyFailures = new Set<string>()
const PROXY_FAILURE_LOG_LIMIT = 20

/** Report a failed proxy fetch once per distinct target+cause. */
export function reportProxyFailure(target: string, error: unknown): void {
  const cause = (error as { cause?: { message?: string } })?.cause?.message
  const key = `${target}|${cause ?? ''}`

  if (reportedProxyFailures.has(key) || reportedProxyFailures.size >= PROXY_FAILURE_LOG_LIMIT) return
  reportedProxyFailures.add(key)

  const suppressed = reportedProxyFailures.size === PROXY_FAILURE_LOG_LIMIT
    ? ' (further proxy failures will not be logged)'
    : ''

  // h3 swallows a failed fetch into an opaque 502 with the reason only on `error.cause`, which
  // Nuxt doesn't surface — so without this an unreachable upstream and an illegal outgoing request
  // look identical, and diagnosing one means instrumenting h3 by hand.
  console.error(`[lukk] app-API proxy failed for ${redactCredentials(target)}${cause ? ` — ${cause}` : ''}${suppressed}`)
}

/** Cap on escape-rejection lines per process — an unauthenticated caller controls the rate. */
const ESCAPE_LOG_LIMIT = 50
let escapesLogged = 0

/**
 * Answer a request whose upstream URL `resolveTarget` refused, telling the two causes apart.
 *
 * An unusable BASE is a deployment fault — a `baseURL`/`api.target` that isn't an absolute
 * http(s) URL, classically an unset build-time env var baked in as `"undefined/auth"`. An
 * escaping SUBPATH is a traversal attempt. Both answer 400 with a body that never echoes config,
 * but the cause is logged server-side and the config case says so: reporting a misconfigured base
 * as "Invalid path." sends operators hunting for a route mismatch that doesn't exist.
 *
 * The module validates both bases at build, so the config branch is only reachable when runtime
 * config is overridden after the build (e.g. `NUXT_LUKK_BASE_URL`).
 */
export function rejectUnresolvedTarget(event: H3Event, base: string, label: string, subpath: string): { message: string } {
  if (!isResolvableBase(base)) {
    // A deployment fault, not a bad request — answer 5xx so uptime alerting, CDNs and health checks
    // treat a total auth outage as the server error it is, instead of filing it as client noise.
    setResponseStatus(event, 500)
    reportUnusableBase(label, base)
    // Named by the setting at fault: the auth proxy's `baseURL`, or the app-API proxy's `api.target`.
    return { message: `Proxy target could not be resolved — check the ${label} configuration.` }
  }
  setResponseStatus(event, 400)
  // Truncated + JSON-escaped (no forged lines) and capped: this is reachable unauthenticated on a
  // GET, so an unbounded line-per-request would be a log-cost amplification vector.
  if (escapesLogged < ESCAPE_LOG_LIMIT) {
    escapesLogged++
    const suppressed = escapesLogged === ESCAPE_LOG_LIMIT ? ' (further path rejections will not be logged)' : ''
    console.warn(`[lukk] Rejected a proxy path that escapes ${label}: ${JSON.stringify(subpath.slice(0, 200))}${suppressed}`)
  }
  return { message: 'Invalid path.' }
}

/**
 * A GET or HEAD sent by another site, or a same-site sibling, that is not a top-level navigation — a
 * subresource, fetch or framed document riding the session cookie. Only browsers send `Sec-Fetch-*`, so
 * a non-browser caller (no cookie to ride) is never caught.
 *
 * The exemption keys on `Sec-Fetch-Dest: document`, not on `Sec-Fetch-Mode: navigate`: a NESTED
 * navigation — an `<iframe>`, `<frame>`, `<embed>` or `<object>` another site points here — is a
 * navigation too, and it is the other site's doing, not a link the visitor followed. Only a top-level
 * document is (Fetch Metadata Request Headers §2.1).
 */
export function isForeignSubresource(event: H3Event): boolean {
  const site = getRequestHeader(event, 'sec-fetch-site')
  return (event.method === 'GET' || event.method === 'HEAD')
    && (site === 'cross-site' || site === 'same-site')
    && getRequestHeader(event, 'sec-fetch-dest') !== 'document'
}

/**
 * CSRF guard: true when a state-changing (non-GET/HEAD) request carries an
 * `Origin` whose host isn't this app's. The proxies are same-origin by design,
 * so a foreign Origin means a cross-site request riding the session cookie.
 */
export function isForeignOrigin(event: H3Event, secure = true): boolean {
  if (event.method === 'GET' || event.method === 'HEAD') return false

  // Browsers send this on every request and non-browsers send it never, so when it IS present and
  // says cross-site, that is decisive — including for a request whose `Origin` we'd otherwise have
  // to reason about.
  //
  // Stryker disable next-line StringLiteral: the `?? ''` fallback is unkillable — it is only reached
  // when the header is absent, and NO string is in that two-element array, so every replacement for
  // it yields the same `false`. (Line-granular, so the two array literals are ignored with it; they
  // stay pinned by the cross-site/same-site cases in proxy-utils.test.ts.)
  if (['cross-site', 'same-site'].includes(getRequestHeader(event, 'sec-fetch-site') ?? '')) return true

  const origin = getRequestHeader(event, 'origin')
  // Absent Origin is left permissive: every browser sends it on a non-GET, so this is a non-browser
  // caller — which has no sealed cookie to ride. `SameSite=Strict` is the primary layer here; this
  // check is the second one.
  if (!origin) return false

  const host = getRequestHeader(event, 'host')

  try {
    const url = new URL(origin)

    if (url.host !== host) return true

    // Compare the SCHEME against `cookieSecure`, NOT against the transport. TLS almost always
    // terminates at a proxy, so the socket Nitro sees is plain either way — and in Node a
    // plain-HTTP socket has no `encrypted` property at all, so any attempt to infer the scheme
    // from it answers the same for a production request and for `nuxi dev` over http. Getting that
    // backwards 403s every non-GET in dev.
    //
    // `cookieSecure` is decided once at build and never sniffed from a header, and it is exactly
    // the right question: when the session cookie is Secure, a page served over http cannot be
    // holding one, so an http Origin is either credential-less (harmless) or a downgrade attempt.
    // When it is off — dev over plain http — there is no scheme to insist on.
    return secure && url.protocol !== 'https:'
  }
  catch {
    return true
  }
}

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/

/**
 * The canonical form of an exact IPv4/IPv6 address, or `''`.
 *
 * Deliberately not `node:net`'s `isIP`. It does resolve on the worker/edge presets — Nitro aliases
 * it to unenv — but the shim's `isIPv6` is a full-form-only regex that rejects EVERY compressed
 * address (`::1`, `2001:db8::1`) while accepting `999.999.999.999`. Silently dropping all IPv6
 * visitors on edge is worse than not using it, so IPv6 goes through the WHATWG host parser instead:
 * its IPv6 grammar and bracketed serialization are normative, so this behaves identically on Node,
 * Bun, Deno and workerd. The charset guard runs FIRST because the parser reads trailing junk as a
 * path — `http://[::1]/x]` has host `[::1]`, so `::1]/x` would otherwise pass as an address.
 *
 * Returning the parser's canonical form matters beyond tidiness: this value becomes an upstream
 * rate-limit key, and `2001:0db8:0000:...:0001` and `2001:db8::1` are the same host but would
 * otherwise get separate buckets.
 */
function normalizeIp(value: string): string {
  if (IPV4.test(value)) return value
  // Stryker disable next-line ConditionalExpression: dropping the length test cannot change the
  // ANSWER, only the cost of reaching it — no IPv6 literal can exceed 45 characters (eight 4-digit
  // groups + seven colons = 39; six groups + six colons + a 15-char IPv4 tail = 45), and the WHATWG
  // parser rejects a longer one anyway. It bounds the work done for a huge header, nothing else.
  // (Line-granular, so the whole-condition mutants go with it; the charset half is pinned by the
  // `::1]/foo` cases, which fail outright without it.)
  if (value.length > 45 || /[^0-9a-f:.]/i.test(value)) return '' // longer than any IPv6 literal
  try { return new URL(`http://[${value}]`).hostname.slice(1, -1) }
  catch { return '' }
}

/**
 * The VISITOR's address, from a header the operator's trusted edge sets — or `''` when there isn't
 * one to be had.
 *
 * It never falls back to the socket address. Behind any reverse proxy that address is the PROXY, so
 * an upstream keying rate limits on it sees every visitor as one identity (`throttle:5,1` becomes
 * 5/min globally). A caller that would rather say nothing than assert a wrong identity — the auth
 * paths, whose value becomes a rate-limit key at lukk — needs to tell "no visitor known" apart from
 * "this server"; one that must always assert something composes the fallback itself.
 *
 * **A list is rejected outright**, and that is the security-critical part. A header the edge SETS
 * carries exactly one address; Node joins duplicates with `", "` and the CLIENT's copy arrives
 * FIRST, so on an edge that appends (or merely fails to strip the client's copy) the leftmost entry
 * is attacker-chosen. Taking it would let a visitor forge `$request->ip()` upstream — worse than the
 * shared-bucket problem this option exists to fix. Refusing a list turns that misconfiguration into
 * a visible loss of function instead of a silent spoof. The module also warns at build when an
 * append-style header (`x-forwarded-for`, `forwarded`) is named.
 *
 * Trusting a header is only sound if the request cannot reach this server EXCEPT through that edge.
 * There is no socket-peer check here (unlike Laravel's `TrustProxies`), so if the origin is directly
 * reachable — a leaked origin IP, no firewall on the CDN's ranges — a client can simply set the
 * header itself. Lock the origin down before enabling this.
 */
export function visitorIp(event: H3Event, clientIpHeader?: string): string {
  if (!clientIpHeader) return ''
  const raw = getRequestHeader(event, clientIpHeader)?.trim()
  if (!raw || raw.includes(',')) return ''
  return normalizeIp(raw)
}

// Lives in `shared` so the step-up header validation reads the same list (see `RESERVED_HEADERS`).
export { SPOOFABLE_FORWARDING } from '../shared'

/**
 * Hop-by-hop headers, which a proxy MUST NOT forward (RFC 9110 §7.6.1).
 *
 * h3's `proxyRequest` already drops `connection`, `keep-alive`, `upgrade` and `transfer-encoding`;
 * these are the rest of the standard set, plus `proxy-authorization`, which is credential material
 * scoped to this hop alone.
 */
const HOP_BY_HOP: readonly string[] = [
  'te',
  'trailer',
  'proxy-connection',
  'proxy-authenticate',
  'proxy-authorization',
]

/**
 * Headers `fetch` refuses to let you set — blank or not.
 *
 * undici throws `UND_ERR_INVALID_ARG` ("invalid keep-alive header") rather than ignoring the
 * assignment, so putting one of these in the outgoing header bag makes the proxy fetch fail
 * outright. They also never need blanking: fetch manages the connection itself and will not forward
 * them whatever the inbound request said.
 *
 * This matters because `Connection: keep-alive` is what every HTTP/1.1 client sends, and the
 * standard nginx reverse-proxy config for a Nitro app sets `Connection: upgrade` unconditionally —
 * so the names parsed out of that header routinely include one of these.
 */
const UNSETTABLE: ReadonlySet<string> = new Set(['connection', 'keep-alive', 'upgrade', 'transfer-encoding'])

/**
 * The hop-by-hop headers to blank for THIS request: the fixed set above, plus every field named in
 * the request's own `Connection` header.
 *
 * That second part is the half h3 doesn't do. RFC 9110 §7.6.1 requires a proxy to parse `Connection`
 * and "remove any header field(s) from the message with the same name as the connection-option" —
 * h3 drops `Connection` itself but forwards the fields it named, so a header the client explicitly
 * marked as single-hop reaches the upstream with the instruction to strip it gone.
 *
 * Names the proxy sets deliberately are never blanked by this: a client cannot use `Connection` to
 * strip its own `authorization`, the injected step-up header, or the asserted `x-forwarded-for`.
 */
// Stryker disable next-line ArrayDeclaration: seeding the default `keep` is only observable for a
// caller that omits the argument AND a client whose `Connection` names the seeded literal — and the
// one production call site always passes a list. Killing it would mean writing Stryker's own
// placeholder string into a test, which pins nothing about this function.
export function hopByHopHeaders(event: H3Event, keep: readonly string[] = []): Record<string, string> {
  const named = (getRequestHeader(event, 'connection') ?? '')
    .split(',')
    .map(name => name.trim().toLowerCase())
    .filter(Boolean)

  const protectedNames = new Set(keep.map(name => name.toLowerCase()))
  const blanked: Record<string, string> = {}

  for (const name of [...HOP_BY_HOP, ...named]) {
    if (!protectedNames.has(name) && !UNSETTABLE.has(name)) blanked[name] = ''
  }

  return blanked
}

/**
 * The `Via` header this proxy adds to the request it forwards (RFC 9110 §7.6.3).
 *
 * A pseudonym rather than a host name: §7.6.3 explicitly permits one, and the alternative leaks the
 * internal hostname of the BFF to the upstream. Request direction only — sending `Via` back to the
 * browser would advertise the proxy's presence and version to anything that asks, for no benefit
 * the browser can use.
 */
export function viaHeader(event: H3Event): string {
  const received = getRequestHeader(event, 'via')?.trim()
  // Via records the protocol version of the message RECEIVED (RFC 9110 §7.6.3). Optional-chained:
  // the non-Node presets (workerd, Deno, Bun) have no `node.req`, and neither do unit tests.
  const hop = `${event.node?.req?.httpVersion ?? '1.1'} lukk-nuxt`

  return received ? `${received}, ${hop}` : hop
}

/** How long a server-side call to lukk may take before it is treated as an outage. */
export const UPSTREAM_TIMEOUT_MS = 15_000

/**
 * `fetch` and `read`, abandoned together after `UPSTREAM_TIMEOUT_MS`. With no limit a hung lukk held
 * every request waiting on it until the runtime's own socket timeout. The abort surfaces as the network
 * error it is; callers already treat that as an outage, not a verdict on the session.
 *
 * The deadline covers `read` — the body — and not only the headers: aborting the signal errors a body
 * still being read (Fetch §"abort the fetch"), so one that sends its headers and then stalls fails at
 * the deadline instead of hanging the caller. That is why the reader is an argument: a `Response` handed
 * back from here would be read after the timer was gone.
 *
 * **Never for `/refresh`.** An abort cannot un-rotate a token lukk has already rotated — see `rawRefresh`.
 */
export async function fetchUpstream<T>(input: string, init: RequestInit, read: (response: Response) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`lukk did not answer within ${UPSTREAM_TIMEOUT_MS} ms`)), UPSTREAM_TIMEOUT_MS)
  try {
    return await read(await fetch(input, { ...init, signal: controller.signal }))
  }
  finally {
    clearTimeout(timer)
  }
}

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
 * Containment is at the URL layer: `..` and its `%2e` spellings are normalized away, but forms the
 * spec does NOT treat as dot-segments (`..%2f`, `%252e%252e`) stay literal in the path and are
 * forwarded percent-encoded. That's correct and same-origin, but it means an upstream that decodes
 * a second time owns that decision — don't read this as full path normalization on lukk's behalf.
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
  const target = new URL(`${b.href.replace(/\/$/, '')}/${subpath.replace(/^\//, '')}`)
  if (!`${target.origin}${target.pathname}/`.startsWith(prefix)) return null
  return target.toString()
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
    return { message: 'Proxy target could not be resolved — check the lukk baseURL configuration.' }
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
 * CSRF guard: true when a state-changing (non-GET/HEAD) request carries an
 * `Origin` whose host isn't this app's. The proxies are same-origin by design,
 * so a foreign Origin means a cross-site request riding the session cookie.
 */
export function isForeignOrigin(event: H3Event): boolean {
  if (event.method === 'GET' || event.method === 'HEAD') return false
  const origin = getRequestHeader(event, 'origin')
  if (!origin) return false
  const host = getRequestHeader(event, 'host')
  try {
    return new URL(origin).host !== host
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

/**
 * Headers a browser can set that name a client address, blanked before the app-API proxy forwards.
 *
 * The upstream decides which of these to trust (Laravel's `TrustProxies` honours a configured mask
 * and CDNs read their own), so any one arriving from the BROWSER is an attempt to choose the
 * upstream's idea of `$request->ip()` — the value that becomes a rate-limit and lockout key. The
 * proxy asserts `x-forwarded-for` itself and blanks the rest.
 *
 * Blanked rather than deleted: `proxyRequest` merges over the inbound headers, and an empty string
 * replaces where an absent key would leave the client's value in place.
 */
export const SPOOFABLE_FORWARDING: Record<string, string> = {
  'x-forwarded-host': '',
  'x-forwarded-proto': '',
  'x-forwarded-port': '',
  'x-forwarded-server': '',
  'x-forwarded': '',
  'x-original-forwarded-for': '',
  'x-http-forwarded-for': '',
  'forwarded': '',
  'x-real-ip': '',
  'x-client-ip': '',
  'x-remote-ip': '',
  'x-remote-addr': '',
  'x-originating-ip': '',
  'client-ip': '',
  'true-client-ip': '',
  'cf-connecting-ip': '',
  'cf-connecting-ipv6': '',
  'cf-pseudo-ipv4': '',
  'fastly-client-ip': '',
  'x-cluster-client-ip': '',
  'x-azure-clientip': '',
  'x-azure-socketip': '',
  'fly-client-ip': '',
  'x-vercel-forwarded-for': '',
  'x-vercel-proxied-for': '',
  'x-appengine-user-ip': '',
  'do-connecting-ip': '',
  'oai-host': '',
}

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
export function hopByHopHeaders(event: H3Event, keep: readonly string[] = []): Record<string, string> {
  const named = (getRequestHeader(event, 'connection') ?? '')
    .split(',')
    .map(name => name.trim().toLowerCase())
    .filter(Boolean)

  const protectedNames = new Set(keep.map(name => name.toLowerCase()))
  const blanked: Record<string, string> = {}

  for (const name of [...HOP_BY_HOP, ...named]) {
    if (!protectedNames.has(name)) blanked[name] = ''
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

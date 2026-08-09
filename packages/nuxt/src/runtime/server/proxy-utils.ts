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
/** Bases already reported, so a broken deploy logs once per value instead of once per request. */
const reportedBases = new Set<string>()
/** Cap on escape-rejection lines per process — an unauthenticated caller controls the rate. */
const ESCAPE_LOG_LIMIT = 50
let escapesLogged = 0

export function rejectUnresolvedTarget(event: H3Event, base: string, label: string, subpath: string): { message: string } {
  if (!isResolvableBase(base)) {
    // A deployment fault, not a bad request — answer 5xx so uptime alerting, CDNs and health checks
    // treat a total auth outage as the server error it is, instead of filing it as client noise.
    setResponseStatus(event, 500)
    // Fixed server config, so the message is identical on every request: log it once rather than
    // once per request for as long as the deploy stays broken.
    if (!reportedBases.has(base)) {
      reportedBases.add(base)
      console.error(`[lukk] ${label} is not an absolute http(s) URL (got ${JSON.stringify(redactCredentials(base))}) — cannot resolve the proxy target. Check the build-time environment variables for this deploy.`)
    }
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

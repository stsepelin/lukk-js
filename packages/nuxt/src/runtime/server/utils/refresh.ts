import { reportUnusableBase, resolveTarget } from '../proxy-utils'

export interface TokenSession {
  access?: string
  refresh?: string
  confirmation?: string
}

// Per-session single-flight, shared by BOTH proxies (the lukk-auth `bff.ts` and the
// app-API proxy) so a concurrent auth-401 refresh and an app-API proactive refresh
// for the same session collapse to ONE `/refresh` — the rotating token is never
// replayed (which reuse detection would punish with a family revoke).
const inflightRefresh = new Map<string, Promise<RefreshResult>>()

/**
 * The outcome of a rotation attempt.
 *
 * `retryable` is the load-bearing part: only a definitive rejection by lukk (401/403 — the token is
 * revoked, reused, or expired) means the session is over. A 429, a 5xx, or an unusable `baseURL`
 * leaves the refresh token UNCONSUMED and still valid, so a caller must not discard the session over
 * one. Collapsing every failure into "no pair" turned a transient throttle into a permanent logout.
 */
export type RefreshResult = { pair: TokenSession | null, expiresIn?: number, retryable: boolean }

/** Single-flight the server-side refresh per session, returning the rotation outcome. */
export function refreshOnce(session: { id?: string, data: TokenSession }, baseURL: string, clientIp = ''): Promise<RefreshResult> {
  const id = session.id
  // No id → don't key the map (an empty key would collapse distinct sessions).
  if (!id) return rawRefresh(session.data.refresh!, baseURL, clientIp)
  const existing = inflightRefresh.get(id)
  if (existing) return existing
  const run = rawRefresh(session.data.refresh!, baseURL, clientIp).finally(() => inflightRefresh.delete(id))
  inflightRefresh.set(id, run)
  return run
}

async function rawRefresh(refreshToken: string, baseURL: string, clientIp: string): Promise<RefreshResult> {
  // `/refresh` is a fixed literal that cannot escape, so a null here means only one thing: an
  // unusable `baseURL` (the module rejects one at build; reachable via a post-build runtime
  // override). Treat it as "not refreshable" rather than fetching `null` and throwing something
  // unreadable — and report it through the shared reporter, which masks credentials and logs once
  // per value, since this path runs per SSR render and per app-API request with an aged token.
  const target = resolveTarget(baseURL, '/refresh')
  if (!target) {
    reportUnusableBase('lukk `baseURL`', baseURL)
    // A deployment fault, not a dead session — the token was never even sent.
    return { pair: null, retryable: true }
  }
  // lukk rate-limits `/refresh` on `$request->ip()` too (30/60s by default), and this is the
  // highest-volume auth call in BFF mode — every proxied 401 and every SSR hydration lands here.
  // Without the visitor's address all of them share one bucket, so a busy deployment throttles
  // itself; with it, login and the refresh that follows also key on the same identity.
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Accept': 'application/json' }
  if (clientIp) headers['X-Forwarded-For'] = clientIp
  const res = await fetch(target, {
    method: 'POST',
    headers,
    body: JSON.stringify({ refresh_token: refreshToken }),
    // Never follow an upstream 3xx: a 307/308 preserves this POST body, which would
    // re-send the rotating refresh token to the redirect host (CWE-918/200). An opaque
    // redirect is not `ok`, so it falls through to the not-ok branch below.
    redirect: 'manual',
  })

  // Only lukk actually rejecting the token ends the session. Anything else — a throttle, an outage,
  // a redirect we refused — left it unconsumed, so report it retryable and keep the session.
  if (!res.ok) return { pair: null, retryable: res.status !== 401 && res.status !== 403 }

  const pair = await res.json() as { access_token: string, refresh_token?: string, expires_in?: number }

  return { pair: { access: pair.access_token, refresh: pair.refresh_token ?? refreshToken }, expiresIn: pair.expires_in, retryable: false }
}

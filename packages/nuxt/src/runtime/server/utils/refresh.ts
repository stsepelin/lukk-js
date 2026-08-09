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
const inflightRefresh = new Map<string, Promise<TokenSession | null>>()

/** Single-flight the server-side refresh per session, returning the new token pair. */
export function refreshOnce(session: { id?: string, data: TokenSession }, baseURL: string): Promise<TokenSession | null> {
  const id = session.id
  // No id → don't key the map (an empty key would collapse distinct sessions).
  if (!id) return rawRefresh(session.data.refresh!, baseURL)
  const existing = inflightRefresh.get(id)
  if (existing) return existing
  const run = rawRefresh(session.data.refresh!, baseURL).finally(() => inflightRefresh.delete(id))
  inflightRefresh.set(id, run)
  return run
}

async function rawRefresh(refreshToken: string, baseURL: string): Promise<TokenSession | null> {
  // `/refresh` is a fixed literal that cannot escape, so a null here means only one thing: an
  // unusable `baseURL` (the module rejects one at build; reachable via a post-build runtime
  // override). Treat it as "not refreshable" rather than fetching `null` and throwing something
  // unreadable — and report it through the shared reporter, which masks credentials and logs once
  // per value, since this path runs per SSR render and per app-API request with an aged token.
  const target = resolveTarget(baseURL, '/refresh')
  if (!target) {
    reportUnusableBase('lukk `baseURL`', baseURL)
    return null
  }
  const res = await fetch(target, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken }),
    // Never follow an upstream 3xx: a 307/308 preserves this POST body, which would
    // re-send the rotating refresh token to the redirect host (CWE-918/200). An opaque
    // redirect is not `ok`, so it falls through to the null return below.
    redirect: 'manual',
  })
  if (!res.ok) return null
  const pair = await res.json() as { access_token: string, refresh_token?: string }
  return { access: pair.access_token, refresh: pair.refresh_token ?? refreshToken }
}

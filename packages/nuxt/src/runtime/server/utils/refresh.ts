import { resolveTarget } from '../proxy-utils'

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
  const target = resolveTarget(baseURL, '/refresh')!
  const res = await fetch(target, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken }),
  })
  if (!res.ok) return null
  const pair = await res.json() as { access_token: string, refresh_token?: string }
  return { access: pair.access_token, refresh: pair.refresh_token ?? refreshToken }
}

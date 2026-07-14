import type { TokenSession } from './utils/refresh'

// RFC 6265bis §5.6: the browser silently drops a cookie whose name+value exceeds 4096 octets. The sealed
// __Host-lukk-session holds access + refresh + confirmation, so a backend embedding many claims via
// `Lukk::tokenClaimsUsing` can push it over — after which every request is anonymous and auth breaks
// intermittently, with no error surfaced. The iron seal inflates the JSON ~1.34× plus a ~280-byte
// envelope, so a ~2.6 KB plaintext session lands near the limit; warn while there's still headroom to trim.
const SESSION_DATA_BUDGET = 2600

/**
 * Dev-time warning when the sealed session is nearing the 4096-octet browser cookie limit. Shared by
 * every path that reseals the token session (`bff.ts`, `hydrate.ts`) so an oversized session warns
 * wherever it's first written — including the SSR reseal, which can cross the budget before any
 * `bff.ts` request does.
 */
export function warnIfSessionTooLarge(session: { data: TokenSession }): void {
  if (JSON.stringify(session.data).length > SESSION_DATA_BUDGET) {
    console.warn(
      '[lukk] The sealed __Host-lukk-session cookie is nearing the 4096-octet browser limit (RFC 6265bis §5.6); '
      + 'above it the browser silently drops it and every request becomes anonymous. '
      + 'Trim your access-token claims (Lukk::tokenClaimsUsing) to shrink the sealed session.',
    )
  }
}

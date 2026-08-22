/**
 * The client half of lukk's abilities (scopes).
 *
 * **These are UI hints, never enforcement.** The server gates every request on the `scope` claim in
 * the access token; this only lets you avoid rendering a button that would come back 403. Never use
 * it to decide whether an action is *allowed* — a client-side check is one devtools console away
 * from being true.
 *
 * The matcher deliberately mirrors `Lukk\Support\Abilities` character for character, and the
 * conformance suite pins the two against a live server so they cannot drift.
 */

/**
 * Whether a granted list satisfies one required ability.
 *
 * Matching is exact, plus two wildcards **in the grant**:
 *   `*`          — everything
 *   `orders.*`   — anything under the `orders.` prefix, but *not* the bare `orders`
 *
 * A wildcard is never honoured in the *check*: `can(a, 'orders.*')` asks whether the literal
 * ability `orders.*` was granted, so a caller can't widen their own question. Comparison is
 * case-sensitive — scope tokens are opaque strings (RFC 6749 §3.3), so `Orders.Read` and
 * `orders.read` are different abilities.
 *
 * `undefined` means the **server doesn't use abilities** and everything is permitted, while `[]`
 * means it does and this token was granted nothing. That distinction is the whole reason lukk omits
 * the key rather than sending `[]`: treating "not in use" as "denied" would blank the UI of every
 * app that upgraded without opting in.
 */
export function can(granted: unknown, ability: string): boolean {
  const list = normalize(granted)

  return list === undefined ? true : matches(list, ability)
}

/**
 * The matcher itself, against an ALREADY-normalized list.
 *
 * `ability` is guarded as carefully as the grant is. It used to be trusted, and
 * `ability.startsWith` is reached only inside the `grant.endsWith('.*')` branch — so a non-string
 * ability threw a `TypeError` **only for users holding a wildcard grant**. A developer with a narrow
 * grant saw `false` and shipped; the admin got a blank component. `v-for="p in permissionsFromApi"`
 * with `v-if="can(p)"` is all it takes.
 */
function matches(list: string[], ability: unknown): boolean {
  if (typeof ability !== 'string' || ability === '') return false

  return list.some(grant =>
    grant === '*'
    || grant === ability
    || (grant.endsWith('.*') && ability.startsWith(grant.slice(0, -1))),
  )
}

/**
 * `LukkUser.abilities?: string[]` is a COMPILE-TIME claim about a JSON body that came off the
 * network — the app's own user endpoint decides its shape, and a single-role app returning
 * `abilities: "admin"` is an easy mistake to make. Without this, every helper here threw a
 * `TypeError`, and `v-if="can('x')"` throwing takes the whole component render down.
 *
 * Absent (`undefined`/`null`) keeps meaning "this server doesn't use abilities" → permitted.
 * Anything else present but malformed means it DOES use them and we cannot tell what was granted,
 * so it grants nothing — the same direction the server takes, where `Abilities::fromScope()` maps a
 * non-string `scope` claim to an empty grant. Non-string entries inside a real array are dropped
 * for the same reason.
 */
export function normalize(granted: unknown): string[] | undefined {
  if (granted === undefined || granted === null) return undefined
  if (!Array.isArray(granted)) return []

  // Entries the SERVER would have refused at mint are dropped, so the client's rule is a subset of
  // the server's by construction rather than by agreement. A comma is the sharp one: the route gate
  // splits `lukk.ability:a,b` on it, so a grant containing one can be matched here and refused
  // there. Unreachable while `abilities` comes from lukk's `UserResource`; reachable the moment an
  // app publishes the field from its own source, which the `string[]` type invites.
  return granted.filter((g): g is string =>
    typeof g === 'string' && g !== '' && !/[,\s]/.test(g) && g.length <= MAX_ABILITY_LENGTH,
  )
}

/** Mirrors `Lukk\Support\Abilities::MAX_ABILITY_LENGTH`. */
const MAX_ABILITY_LENGTH = 128

/** Whether the server is gating on abilities at all — i.e. it published a list, malformed or not. */
export function enforcesAbilities(granted: unknown): boolean {
  return normalize(granted) !== undefined
}

/** The inverse of {@link can} — reads better in a template than `!can(...)`. */
export function cannot(granted: unknown, ability: string): boolean {
  return !can(granted, ability)
}

/** lukk's own abilities, required from a PINNED token on lukk's own routes. */
export const LUKK_SESSIONS = 'lukk.sessions'
export const LUKK_ACCOUNT = 'lukk.account'
/**
 * Erasing or exporting the account. Deliberately NOT satisfied by `LUKK_ACCOUNT` — the matcher's
 * prefix rule makes an exact grant of `lukk.account` miss `lukk.account.delete`, mirroring the
 * server, where widening the older ability would have handed every token carrying it the power to
 * destroy the account.
 */
export const LUKK_ACCOUNT_DELETE = 'lukk.account.delete'

/** Whether **any** of the abilities is granted. An empty list is never satisfied. */
export function canAny(granted: unknown, abilities: string[]): boolean {
  return abilities.some(ability => can(granted, ability))
}

/** Whether **every** ability is granted. An empty list is never satisfied — matching the server,
 *  where `lukk.abilities:` with no arguments is a route bug rather than a free pass. */
export function canAll(granted: unknown, abilities: string[]): boolean {
  return abilities.length > 0 && abilities.every(ability => can(granted, ability))
}

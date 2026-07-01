/**
 * The authenticated user, as your `user.endpoint` returns it. lukk reads only the
 * verification fields below; **extend this interface with your own fields** via module
 * augmentation, and they're typed everywhere `useLukkAuth().user` is used:
 *
 * ```ts
 * declare module 'lukk-core' {
 *   interface LukkUser { name: string, roles: string[] }
 * }
 * ```
 */
export interface LukkUser {
  /** The identifier — Laravel `id` / OIDC `sub`. */
  id?: string | number
  /** Laravel's nullable verification timestamp. */
  email_verified_at?: string | null
  /** OIDC-canonical verification boolean — accepted as an alternative to `email_verified_at`. */
  email_verified?: boolean
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Siblings of `data` that mark a paginated collection (never a single resource) —
// Laravel forces `meta`/`links` on paginated responses even under `withoutWrapping()`.
const ENVELOPE_KEYS = ['meta', 'links'] as const

/**
 * Shape a `user.endpoint` response into the user object. Auto-unwraps a clean Laravel
 * API-Resource wrapper — `{ data: {...} }` with **no** `meta`/`links` envelope — or a configured
 * `key`. Returns `null` for a non-object body, an `{ errors }` envelope (a Laravel error body served
 * with a 2xx), or an explicit `{ data: null }` — so it never fabricates a user from an error/empty shape.
 *
 * @param key the wrapper key to unwrap (default `'data'`); pass `false` to disable unwrapping.
 */
export function shapeUser(raw: unknown, key: string | false = 'data'): LukkUser | null {
  if (!isPlainObject(raw)) return null
  if ('errors' in raw) return null // an error envelope is never a user → logged-out
  if (key !== false && key in raw && !ENVELOPE_KEYS.some(k => k in raw)) {
    const inner = raw[key]
    if (inner === null) return null // e.g. `{ data: null }` → not authenticated
    if (isPlainObject(inner)) return inner as LukkUser
  }
  return raw as LukkUser
}

/**
 * Whether the user's email is verified — accepts Laravel's `email_verified_at` (a non-null
 * timestamp) **or** the OIDC-canonical boolean `email_verified`, so either wire shape works.
 */
export function isEmailVerified(user: LukkUser | null): boolean {
  return !!user && (user.email_verified === true || Boolean(user.email_verified_at))
}

/**
 * Dev-time diagnostic: returns a warning string when a "logged-in" user still looks like an
 * un-unwrapped envelope (a nested `data`/`meta`/`links` and no `id`) — i.e. the endpoint shape
 * wasn't handled — or `null` when the shape looks fine. Bindings call this in dev only.
 */
export function userShapeWarning(user: LukkUser | null): string | null {
  if (!isPlainObject(user) || user.id !== undefined) return null
  const looksWrapped = isPlainObject(user.data) || 'meta' in user || 'links' in user
  if (!looksWrapped) return null
  return 'lukk: your user.endpoint response has no `id` and looks wrapped/enveloped (`data`/`meta`/`links`). '
    + 'lukk auto-unwraps a clean `{ data: {...} }`; for another wrapper set `user.key`, or return a flat user '
    + '(Laravel: `JsonResource::withoutWrapping()` / `$wrap = null`, or extend `Lukk\\Http\\Resources\\UserResource`).'
}

import type { RefreshResult } from './refresh'

/**
 * Rotations that landed after every caller waiting on them had given up — see `REFRESH_HOLD_MS` in
 * `refresh.ts`. In a module of its own so `ended-sessions` can let one go when its session ends without
 * importing the refresh machinery (which imports it).
 *
 * **Per process**, on `globalThis` like the single-flight: a multi-instance BFF without sticky sessions
 * does not share it.
 */
export interface Held {
  /** The refresh token this rotation consumed — the only one that may adopt it. */
  consumed: string
  result: RefreshResult
  /** When it landed, to count the access token's `expires_in` down from. */
  landedAt: number
  /** Taken at least once: what remains is the straggler window. */
  taken: boolean
  timer?: ReturnType<typeof setTimeout>
}

export const heldRefresh: Map<string, Held> = ((globalThis as { __lukkHeldRefresh?: Map<string, Held> }).__lukkHeldRefresh ??= new Map())

/** Let go of the session's held rotation — or only `held`, when given, so a newer one is left alone. */
export function forgetHeldRefresh(key: string, held?: Held): void {
  const current = heldRefresh.get(key)
  if (!current || (held && current !== held)) return
  clearTimeout(current.timer)
  heldRefresh.delete(key)
}

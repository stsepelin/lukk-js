import type { TokenSession } from './refresh'

/**
 * Each session's recent rotations, as links from the refresh token a rotation consumed to the pair it
 * produced — so a request still presenting a consumed token can be handed the session's CURRENT pair
 * instead of replaying that token to lukk. The policy (what is recorded, for how long, who may adopt) lives
 * in `refresh.ts`; this module only holds the data, apart from it so `ended-sessions` can drop a session's
 * journal without importing the refresh machinery, which imports it.
 *
 * **Per process**, on `globalThis` like the single-flight: Nitro's handlers and the Nuxt app's server bundle
 * each get their own copy of a module, and a multi-instance BFF without sticky sessions does not share it.
 */
export interface Link {
  /** The pair the rotation produced. */
  pair: TokenSession
  /** lukk's `expires_in` for its access token, as lukk sent it — counted down from `mintedAt` when handed out. */
  expiresIn?: number
  /** When the refresh that produced it left — when lukk minted it, since lukk rotates on receipt. */
  mintedAt: number
  /**
   * Its pair has reached the session — a caller received it, a request adopted through it, or its pair's own
   * rotation landed. The first taking gives it the straggler window outright; after that its end is only
   * ever brought forward.
   */
  taken: boolean
  /** When this link ends. */
  expiresAt: number
  /** Ends it then. */
  timer: ReturnType<typeof setTimeout>
}

/** Per session id: consumed refresh token → link, oldest first. */
export const refreshJournals: Map<string, Map<string, Link>> = ((globalThis as { __lukkRefreshJournals?: Map<string, Map<string, Link>> }).__lukkRefreshJournals ??= new Map())

/** Drop a session's journal, and every timer it holds. */
export function forgetRefreshJournal(key: string): void {
  const journal = refreshJournals.get(key)
  if (!journal) return
  for (const link of journal.values()) clearTimeout(link.timer)
  refreshJournals.delete(key)
}

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

/**
 * Per session id: the newest refresh token the BFF has produced for it — its HEAD — independent of the links'
 * short windows. A response that took longer than those windows (a slow upstream, a long render) is about to
 * seal a pair; if the session has moved past it, the links that led on may be gone, and only this says so.
 * Kept `REFRESH_HOLD_MS` past the latest rotation, hand-out or response, and while any is out (`holdHead`).
 */
export const refreshHeads: Map<string, Head> = ((globalThis as { __lukkRefreshHeads?: Map<string, Head> }).__lukkRefreshHeads ??= new Map())

/** A session's head. The timer is absent on a tombstone, which lasts while a response is out (`entombHead`). */
interface Head { token: string, timer?: ReturnType<typeof setTimeout> }

/**
 * The head of a session that has ENDED — a logout, or a sign-in that replaced it — while a response that
 * may still seal a pair for it was out. No refresh token lukk mints equals it (they are hex), so
 * `currentPair` answers "the session has moved past this pair" and the cookie is withheld.
 */
export const ENDED_HEAD = '\u0000ended'

/**
 * Leave that tombstone, if a response is out for the session.
 *
 * The record that a session ended lasts ten minutes; an app-API response has no deadline. One that had
 * rotated before the session ended and delivered after the record expired found neither a journal nor a
 * head — which reads as "a session unknown here, seal the pair" — and wrote the ended session's dead
 * cookie back: over the new session's after a sign-in (a false logout at the next refresh), or over the
 * cleared one after a logout. It goes as any head does, a hold after the last response closes.
 */
export function entombHead(key: string): void {
  if (responsesOut.has(key)) refreshHeads.set(key, { token: ENDED_HEAD })
}

/**
 * Per session id: how many responses are out that may still seal a pair for it (`holdHead`). While any is,
 * the session's head stays — the one thing that tells such a response, however late, that the session has
 * moved past the pair it is carrying.
 */
export const responsesOut: Map<string, number> = ((globalThis as { __lukkResponsesOut?: Map<string, number> }).__lukkResponsesOut ??= new Map())

/**
 * Per session id: the step-up confirmation the auth proxy last sealed for it, until the confirmation's own
 * expiry (`holdConfirmation`). A response sealed BEFORE it — an app-API long-poll, a slow renewal — lands
 * after it and would overwrite the cookie without it; at its last moment it carries this one instead (see
 * `deliverPair`). lukk binds a confirmation to the session's refresh family, which rotation keeps, so it
 * holds across every pair of the session — and never into another one, which has another id.
 */
export const confirmationsHeld: Map<string, { token: string, timer: ReturnType<typeof setTimeout> }> = ((globalThis as { __lukkConfirmationsHeld?: Map<string, { token: string, timer: ReturnType<typeof setTimeout> }> }).__lukkConfirmationsHeld ??= new Map())

/** Drop a session's journal, its head and its held confirmation, and every timer they hold. */
export function forgetRefreshJournal(key: string): void {
  // Not an ended session's tombstone while a response is still out for it: it is all that says so.
  if (refreshHeads.get(key)?.token !== ENDED_HEAD || !responsesOut.has(key)) {
    clearTimeout(refreshHeads.get(key)?.timer)
    refreshHeads.delete(key)
  }
  clearTimeout(confirmationsHeld.get(key)?.timer)
  confirmationsHeld.delete(key)
  const journal = refreshJournals.get(key)
  if (!journal) return
  for (const link of journal.values()) clearTimeout(link.timer)
  refreshJournals.delete(key)
}

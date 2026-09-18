import type { Ref } from 'vue'
import { RESTORE_FAILED_KEY } from '../keys'
import { clearPendingLogout, noteSignIn } from './pending-logout'
import { shallowRef, useState } from '#imports'

/**
 * Restore bookkeeping that must outlive `clearNuxtState()`.
 *
 * `ready` is ALSO kept in `useState` — that is how the server hands "I hydrated a user" to the client
 * through the payload. But `useState` is the documented target of `clearNuxtState()`, a common logout
 * idiom: it resets the key (Nuxt 3 to `undefined`; Nuxt 4 deletes it, or with `resetOnClear` puts it back to
 * its initial `false`), nothing sets it to `true` again, and every
 * later `whenReady()` hung. The restore has happened once per app, so the app is where that fact lives.
 */
export interface RestoreState {
  /** The client restore plugin has begun. A `whenReady()` before this is waiting on code not yet running. */
  started: boolean
  /** The client restore has finished. Reactive, so `ready` and `whenReady()` observe it. */
  restored: Ref<boolean>
  /**
   * The session generation. Bumped when a session ENDS (`logout()`) and when a new one BEGINS (a sign-in
   * that issued tokens). Anything that captured an older value — a restore, a refresh, a `fetchUser` —
   * discards its result: without this, a slow restore that landed after a login showed the previous
   * account over the new one's token, and one that landed after `logout()` signed the user back in.
   */
  epoch: number
  /** Bumped by `logout()` only — so a sign-in can tell "logged out meanwhile" from "another sign-in". */
  logouts: number
  /** The refresh in flight, if any. Written by the client plugin's single-flight. */
  refreshing: Promise<unknown> | null
  /**
   * Direct mode: the `sub` of the access token the displayed user was loaded with. A refresh that comes
   * back for a different subject means the tab is showing one account while acting as another.
   */
  subject?: string
  /**
   * A sign-in or logout request on the wire, if any. A refresh that starts meanwhile waits for it: sent
   * alongside, it renews the session that request is replacing or ending — see `signIn`.
   */
  handover: Promise<unknown> | null
  /**
   * The whole of a `logout()`, if one is running — including the gap between an attempt lukk rejected
   * and its retry, when `handover` is deliberately empty so the token can be renewed. Sign-ins wait on
   * this rather than on `handover`: in that gap a sign-in slipped through, and the logout's cleanup then
   * signed the new session out.
   */
  ending: Promise<unknown> | null
  /** Tell other tabs of this app that the session changed. Set by the client plugin where supported. */
  announce?: () => void
  /** The Web Lock shared by this app's tabs. Set by the client plugin where the browser has one. */
  lockName?: string
  /** This app's base, which scopes what it keeps in browser storage. Set by the client plugin. */
  scope?: string
  /**
   * Set by the restore plugin, for the `logout()` it calls next: that call FINISHES the logout an earlier
   * page noted at this time, rather than being a new one. Consumed by that call.
   */
  finishingLogout?: number
  /** That call stood down without sending: the session it was for had been replaced. Read by the restore plugin. */
  logoutStoodDown?: boolean
  /** How many of this tab's operations are using the tab lock — the lock is released when it reaches 0. */
  lockUsers: number
  /** Settles once this tab holds the lock (or gave up waiting for it). */
  lockHeld?: Promise<void>
  /** Hands the lock back. */
  releaseLock?: () => void
}

/**
 * How long a sign-in or `logout()` waits for a refresh already in flight. Long enough for any refresh
 * that is going to answer; bounded, because a request that never settles must not lock the user out.
 */
export const REFRESH_SETTLE_TIMEOUT = 10_000

/**
 * How long an operation waits for another tab's session lock before going ahead without it. Short: a
 * lock held by a healthy tab is released within one request, and any script on the origin can hold the
 * name — every sign-in, logout, refresh and page-load restore would otherwise pay the full wait.
 */
export const TAB_LOCK_WAIT_MS = 3_000

export function restoreState(nuxtApp: object): RestoreState {
  const app = nuxtApp as { _lukkRestore?: RestoreState }
  return (app._lukkRestore ??= { started: false, restored: shallowRef(false), epoch: 0, logouts: 0, refreshing: null, handover: null, ending: null, lockUsers: 0 })
}

/**
 * Wait for a refresh already in flight to finish, whatever its outcome.
 *
 * Call it BEFORE a request that replaces or ends the session. Discarding a late refresh's RESULT is
 * not enough on its own: its response still sets the refresh cookie (direct mode) or the sealed
 * session cookie (BFF). Landing after a login, that put the previous account's session back under
 * the new one; landing after a logout, it re-created the cookie that logout had just cleared.
 */
export function settleRefresh(nuxtApp: object, timeoutMs = REFRESH_SETTLE_TIMEOUT): Promise<void> {
  return settle(restoreState(nuxtApp).refreshing, timeoutMs)
}

/** Resolve once `pending` settles either way, or after `timeoutMs` — whichever comes first. */
export function settle(pending: Promise<unknown> | null, timeoutMs = REFRESH_SETTLE_TIMEOUT): Promise<void> {
  if (!pending) return Promise.resolve()

  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs)
    const done = () => {
      clearTimeout(timer)
      resolve()
    }
    pending.then(done, done)
  })
}

/**
 * Send a sign-in request as a session HANDOVER: wait for a refresh already on the wire, publish the
 * request so a refresh starting meanwhile waits for it, and begin a new session generation the moment
 * the server answers with one.
 *
 * Waiting only on the refresh before was not enough: a refresh STARTED while the credentials were on
 * the wire — a request's 401 retry, an `initSession()` retry — carried the old session's cookie, landed
 * after the login and set it back under the new account.
 *
 * `beginSession` runs inside the published promise, so a waiting refresh sees the new generation when
 * it resumes, and drops itself, whatever order the continuations run in.
 *
 * `current` is `false` when `logout()` ran while the request was out: the session the server just
 * issued must then be ended, not started — the caller logs out again.
 */
export function signIn<T>(nuxtApp: object, send: () => Promise<T>, startsSession: (result: T) => boolean): Promise<{ result: T, current: boolean }> {
  return acrossTabs(nuxtApp, () => handOver(nuxtApp, send, startsSession))
}

async function handOver<T>(nuxtApp: object, send: () => Promise<T>, startsSession: (result: T) => boolean): Promise<{ result: T, current: boolean }> {
  await settleRefresh(nuxtApp)

  const state = restoreState(nuxtApp)
  // And for a logout still running: its cleanup — and the cleared cookie its response carries — would
  // otherwise land after this sign-in succeeded, leaving the visitor signed out and the new session
  // alive upstream with nothing pointing at it. The whole logout, not only its request on the wire.
  await settle(state.ending)
  await settle(state.handover)
  const logouts = state.logouts

  let issued = false
  const sentAt = Date.now()
  const request = send().then((result) => {
    // Even when a logout came first: the server issued a session either way, and the caller is about
    // to end it — starting its generation now stops a refresh waiting on this from renewing it.
    if (startsSession(result)) {
      issued = true
      beginSession(nuxtApp, sentAt)
    }
    return result
  })
  state.handover = request

  let outcome: { result: T, current: boolean }
  try {
    const result = await request
    outcome = { result, current: logouts === state.logouts }
  }
  finally {
    if (state.handover === request) state.handover = null
  }

  if (issued && outcome.current) claimSession(nuxtApp)
  return outcome
}

/**
 * Tell lukk this client received the session it just issued. With lukk's `claim_seconds` on, a session
 * whose first use comes too late is revoked — which is what ends one whose sign-in response never
 * reached the client (a dropped connection, an aborted request). Claiming at once keeps an app that
 * makes no authenticated request for a while from being signed out. Fire-and-forget, after the handover
 * is released; a lukk release without the route answers 404, which is ignored.
 */
function claimSession(nuxtApp: object): void {
  const lukk = (nuxtApp as { $lukk?: { claimSession?: () => Promise<void> } }).$lukk
  void lukk?.claimSession?.().catch(() => {})
}

/**
 * Run `operation` while holding this app's session lock ACROSS TABS.
 *
 * Every tab shares the session cookie, and the in-tab holds above can't see another tab: a logout there
 * cleared the cookie a sign-in here had just set, and tabs refreshing the same token at once leaned on
 * lukk's grace window to not revoke each other. A Web Lock (`navigator.locks`) queues sign-ins, logouts
 * and refreshes across every tab of the app.
 *
 * Within a tab the lock is SHARED rather than re-acquired: a logout renewing its token runs a refresh
 * inside the logout, and a second acquisition of the same exclusive lock would wait on itself. The
 * in-tab holds already order what happens inside one tab.
 *
 * Both sides are capped, so a stuck tab can't lock the others out: an operation waits at most
 * `TAB_LOCK_WAIT_MS` for the lock before going ahead without it, and a tab gives the lock back after
 * `REFRESH_SETTLE_TIMEOUT` even if its operation is still running. Where the browser has no Web Locks
 * (an older browser, plain http), it simply runs.
 */
export async function acrossTabs<T>(nuxtApp: object, operation: () => Promise<T>): Promise<T> {
  const state = restoreState(nuxtApp)
  const locks = state.lockName && typeof navigator !== 'undefined'
    ? (navigator as { locks?: TabLocks }).locks
    : undefined
  if (!locks) return operation()

  if (state.lockUsers++ === 0) state.lockHeld = holdTabLock(locks, state)
  try {
    await state.lockHeld
    return await operation()
  }
  finally {
    if (--state.lockUsers === 0) {
      state.releaseLock?.()
      state.releaseLock = undefined
    }
  }
}

interface TabLocks {
  request: (name: string, options: { signal?: AbortSignal }, callback: () => Promise<void>) => Promise<unknown>
}

function holdTabLock(locks: TabLocks, state: RestoreState): Promise<void> {
  return new Promise((granted) => {
    const giveUp = new AbortController()
    const timer = setTimeout(() => giveUp.abort(), TAB_LOCK_WAIT_MS)

    locks.request(state.lockName!, { signal: giveUp.signal }, () => {
      clearTimeout(timer)
      granted()
      // Held while this tab's operations run — but no longer than the settle cap. A request that hangs
      // (a flaky mobile network) otherwise kept every other tab waiting on each of its operations.
      return new Promise<void>((release) => {
        const cap = setTimeout(release, REFRESH_SETTLE_TIMEOUT)
        state.releaseLock = () => {
          clearTimeout(cap)
          release()
        }
      })
    }).catch(() => {
      // Not granted in time — go ahead without it.
      clearTimeout(timer)
      granted()
    })
  })
}

/**
 * A sign-in issued tokens: start a new session generation. Called once the server has ANSWERED with a
 * session — never before, or a failed login would discard a restore that was still legitimately
 * retrying. Also a definitive answer, so it clears `restoreFailed`: an app with no user endpoint has
 * no `fetchUser` to do that.
 */
export function beginSession(nuxtApp: object, sentAt: number): void {
  const state = restoreState(nuxtApp)
  state.epoch++
  useState<boolean>(RESTORE_FAILED_KEY, () => false).value = false
  // A logout never finished is moot once a sign-in is sent after it — here, or in a tab that left and
  // returns. One asked for while this sign-in was already out still stands.
  clearPendingLogout(state.scope, sentAt)
  noteSignIn(state.scope, sentAt)
  state.announce?.()
}

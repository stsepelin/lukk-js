import type { Ref } from 'vue'
import { RESTORE_FAILED_KEY } from '../keys'
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
}

/**
 * How long a sign-in or `logout()` waits for a refresh already in flight. Long enough for any refresh
 * that is going to answer; bounded, because a request that never settles must not lock the user out.
 */
export const REFRESH_SETTLE_TIMEOUT = 10_000

export function restoreState(nuxtApp: object): RestoreState {
  const app = nuxtApp as { _lukkRestore?: RestoreState }
  return (app._lukkRestore ??= { started: false, restored: shallowRef(false), epoch: 0, logouts: 0, refreshing: null, handover: null })
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
export async function signIn<T>(nuxtApp: object, send: () => Promise<T>, startsSession: (result: T) => boolean): Promise<{ result: T, current: boolean }> {
  await settleRefresh(nuxtApp)

  const state = restoreState(nuxtApp)
  // And for a logout still on the wire: its cleanup — and the cleared cookie its response carries —
  // would otherwise land after this sign-in succeeded, leaving the visitor signed out and the new
  // session alive upstream with nothing pointing at it.
  await settle(state.handover)
  const logouts = state.logouts

  const request = send().then((result) => {
    // Even when a logout came first: the server issued a session either way, and the caller is about
    // to end it — starting its generation now stops a refresh waiting on this from renewing it.
    if (startsSession(result)) beginSession(nuxtApp)
    return result
  })
  state.handover = request

  try {
    const result = await request
    return { result, current: logouts === state.logouts }
  }
  finally {
    if (state.handover === request) state.handover = null
  }
}

/**
 * A sign-in issued tokens: start a new session generation. Called once the server has ANSWERED with a
 * session — never before, or a failed login would discard a restore that was still legitimately
 * retrying. Also a definitive answer, so it clears `restoreFailed`: an app with no user endpoint has
 * no `fetchUser` to do that.
 */
export function beginSession(nuxtApp: object): void {
  restoreState(nuxtApp).epoch++
  useState<boolean>(RESTORE_FAILED_KEY, () => false).value = false
}

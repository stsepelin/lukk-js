import { isRegistrationPending, isTwoFactorChallenge, type LoginInput, type LoginResult, type LukkUser, type RegisterInput, type RegisterResult, shapeUser, userShapeWarning } from 'lukk-core'
import type { ComputedRef, Ref } from 'vue'
import { computed, useNuxtApp, useRuntimeConfig, useState } from '#imports'
import { ACCESS_KEY, CHALLENGE_KEY, CONFIRMATION_KEY, CONFIRMED_KEY, READY_KEY, RESTORE_FAILED_KEY, USER_KEY } from '../keys'
import { isAuthRejection } from '../shared'
import { clearPendingLogout, notePendingLogout, signedInSince } from '../utils/pending-logout'
import { acrossTabs, restoreState, settleRefresh, signIn } from '../utils/restore-state'
import { tokenSubject } from '../utils/token-subject'
import { isPrematureWait, whenReady as settled } from '../utils/when-ready'
import type { RestoreOutcome } from '../plugins/client'
import { useLukkFetch } from './useLukkFetch'

interface PublicLukk {
  mode: 'bff' | 'direct'
  baseURL: string
  confirmationHeader: string
  userEndpoint: string
  userKey: string
}

/**
 * Declared rather than inferred: the module build cannot resolve `#imports`, so an inferred return type
 * shipped as `any` in the published declarations — and `auth.ready.value = true` type-checked in a
 * consumer app.
 */
export interface LukkAuth {
  user: Ref<LukkUser | null>
  loggedIn: ComputedRef<boolean>
  ready: ComputedRef<boolean>
  whenReady: () => Promise<void>
  restoreFailed: ComputedRef<boolean>
  pendingTwoFactor: ComputedRef<boolean>
  register: (input: RegisterInput) => Promise<RegisterResult>
  login: (credentials: LoginInput) => Promise<LoginResult>
  verifyTwoFactor: (code: string) => Promise<void>
  verifyRecoveryCode: (recoveryCode: string) => Promise<void>
  logout: () => Promise<void>
  revokeOtherSessions: () => Promise<void>
  fetchUser: () => Promise<void>
  initSession: () => Promise<void>
}

/**
 * The reactive auth surface. Identical API in every mode — only the transport
 * underneath differs.
 */
export function useLukkAuth(): LukkAuth {
  const nuxtApp = useNuxtApp()
  const { $lukk } = nuxtApp
  // Restore bookkeeping that `clearNuxtState()` cannot erase — see utils/restore-state.
  const state = restoreState(nuxtApp)
  const cfg = useRuntimeConfig().public.lukk as PublicLukk
  // Auth-aware fetch for the current-user load — SSR-correct (forwards the session
  // cookie) unlike a bare `$fetch`, and transport-aware for the bearer.
  const api = useLukkFetch()

  // Shared with the client plugin (`onTokens` writes the access token here).
  const access = useState<string | null>(ACCESS_KEY, () => null)
  const user = useState<LukkUser | null>(USER_KEY, () => null)
  // A pending 2FA challenge token, set by `login` when the user has 2FA enabled.
  const challenge = useState<string | null>(CHALLENGE_KEY, () => null)
  // The step-up confirmation state (managed by `useLukkConfirmation`).
  const confirmation = useState<string | null>(CONFIRMATION_KEY, () => null)
  const confirmed = useState<boolean>(CONFIRMED_KEY, () => false)

  // Loose `!= null`: `clearNuxtState()` leaves these keys `undefined` (Nuxt 3) or deletes them (Nuxt 4 without `resetOnClear`), and
  // a strict check read that as signed in with a pending challenge.
  const loggedIn = computed(() => user.value != null)
  const pendingTwoFactor = computed(() => challenge.value != null)

  // Written by the session plugins only, so it is exposed read-only — the same shape as
  // `useLukkConfirmation().confirmed`.
  const readyFlag = useState<boolean>(READY_KEY, () => false)

  /**
   * True once the session has been RESOLVED, whether that found a signed-in user or not.
   *
   * `loggedIn` alone cannot say "anonymous" — `false` also means "not resolved yet". Gate any
   * decision that would be wrong for a signed-in user on `ready` first: a redirect, a fetch of
   * account-scoped data, restoring a deep link.
   *
   * Where it is `false`:
   *  - **During ANY server render that did not hydrate a user** — including an anonymous BFF visitor,
   *    direct mode (the server never sees the refresh cookie), `ssrHydrate: false`, a prerendered
   *    route, a session the server could not rotate, and a user endpoint that failed on the server.
   *    The server cannot tell these apart, so it does not claim to.
   *  - **In any plugin that runs before `lukk:session-restore`.** Such a plugin must not AWAIT
   *    `whenReady()` in its setup — see {@link whenReady}.
   *
   * **Reading it in a template on a server-rendered page causes a hydration mismatch** whenever the
   * server did not hydrate a user: the server renders `false` and the client sets `true` before it
   * mounts. Read it in logic, or inside `<ClientOnly>`. (`loggedIn` already behaved this way for a
   * session restored on the client.)
   *
   * On the client it is `true` by the time route middleware, component `setup()` and `onMounted`
   * run: Nuxt awaits the restore plugin before the initial navigation and before mounting. It is
   * `true` from the start when the server hydrated the user, so that path stays synchronous.
   *
   * `ready` means the restore FINISHED, not that it reached an answer — see {@link restoreFailed}.
   */
  // `=== true`, not truthiness: `clearNuxtState()` turns the key into `undefined`, and the app-scoped
  // `restored` is what keeps a finished restore finished after that.
  const ready = computed(() => readyFlag.value === true || state.restored.value)

  const restoreFailedFlag = useState<boolean>(RESTORE_FAILED_KEY, () => false)

  /**
   * True when the last restore could not reach an answer, so nobody is signed in but the visitor
   * may well have a valid session: the refresh was throttled (429), the server errored (5xx) or was
   * unreachable, or the refresh worked and the user endpoint then failed the same way.
   *
   * Only a 401/403 means "no session" — the rule `fetchUser` already used. Show a "couldn't reach
   * the server, retry" state here rather than a login prompt, and retry with `initSession()`.
   *
   * Any other status counts too — including a misconfigured endpoint (404) — so a retry there can
   * never succeed; it reports "could not tell", which is still true.
   *
   * Cleared by every DEFINITIVE answer: a user loaded, a 401/403 from the user endpoint, a sign-in,
   * `logout()`.
   * Clearing on those rather than only hiding it while signed in matters — a stale flag from an
   * earlier failed restore otherwise resurfaced once that later session ended, and code gating a
   * redirect on it let a signed-out visitor through.
   */
  const restoreFailed = computed(() => restoreFailedFlag.value === true && !loggedIn.value)

  /**
   * Password login. When the user has 2FA enabled this surfaces a challenge
   * (`pendingTwoFactor` becomes true) instead of logging in — complete it with
   * `verifyTwoFactor` / `verifyRecoveryCode`. Otherwise the token is persisted
   * and the user loaded.
   */
  async function login(credentials: LoginInput): Promise<LoginResult> {
    const { result, current } = await signIn(nuxtApp, () => $lukk.login(credentials), r => !isTwoFactorChallenge(r))
    if (!current) return endSupersededSignIn(result, !isTwoFactorChallenge(result))
    if (isTwoFactorChallenge(result)) {
      // Client-only, for the reason ACCESS_KEY is: a `useState` written during SSR serialises
      // into `__NUXT_DATA__`. A challenge token is a live single-use credential, and at this point
      // in the flow no session cookie exists yet — so `no-store` never fires and a CDN may cache
      // the page with it embedded.
      if (import.meta.client) challenge.value = result.challenge_token
      return result
    }
    await fetchUser()
    return result
  }

  /**
   * Register a new user. Mirrors {@link login}: a successful register starts the session, exactly
   * like logging in. A 2FA-enrolled new user surfaces a challenge (`pendingTwoFactor`); if the
   * server issues no session (register-only, or verification required), it resolves to a
   * `{ registered, requires_verification }` shape — route the user on accordingly.
   */
  async function register(input: RegisterInput): Promise<RegisterResult> {
    const startsSession = (r: RegisterResult) => !isRegistrationPending(r) && !isTwoFactorChallenge(r)
    const { result, current } = await signIn(nuxtApp, () => $lukk.register(input), startsSession)
    if (!current) return endSupersededSignIn(result, startsSession(result))
    if (isRegistrationPending(result)) {
      return result
    }
    if (isTwoFactorChallenge(result)) {
      if (import.meta.client) challenge.value = result.challenge_token
      return result
    }
    await fetchUser()
    return result
  }

  /** Complete a pending 2FA challenge with a TOTP code. */
  function verifyTwoFactor(code: string): Promise<void> {
    return completeTwoFactor({ code })
  }

  /** Complete a pending 2FA challenge with a recovery code. */
  function verifyRecoveryCode(recovery_code: string): Promise<void> {
    return completeTwoFactor({ recovery_code })
  }

  async function completeTwoFactor(input: { code?: string, recovery_code?: string }): Promise<void> {
    if (!challenge.value) throw new Error('lukk: no pending two-factor challenge')
    const challengeToken = challenge.value
    const { current } = await signIn(nuxtApp, () => $lukk.twoFactorChallenge({ challenge_token: challengeToken, ...input }), () => true)
    if (!current) return endSupersededSignIn(undefined, true)
    challenge.value = null
    await fetchUser()
  }

  /**
   * A sign-in whose response landed after `logout()`. The logout is the newer intent, but it went out
   * before this session existed, so it could not end it: the server has just issued a live session
   * (tokens in direct mode, a sealed cookie in BFF) that nothing on screen reflects. End it too.
   */
  async function endSupersededSignIn<T>(result: T, issuedSession: boolean): Promise<T> {
    if (issuedSession) await logout()
    return result
  }

  async function logout(): Promise<void> {
    // Until the logout request itself is on the wire it waits — for another tab's lock, for a refresh
    // already out. A page that navigates away in that moment cancelled it, and the session outlived what
    // the user saw. So if the page starts to unload first, send it right away with `keepalive` (which
    // outlives the page) and skip the ordering: the page is leaving, and ending the session wins.
    //
    // `pagehide` and a `visibilitychange` to hidden both count: iOS Safari doesn't reliably fire
    // `pagehide` for a backgrounded tab it later kills, and the user has already asked to log out.
    // Sending early skips the cross-tab lock — in direct mode a sign-in in another tab at that very moment
    // can lose its cookie — which is the smaller loss than a logout that never happened.
    // And a note the next page finishes it from, should this page be gone before it completes.
    //
    //
    // Unless this call FINISHES a logout an earlier page noted (the restore plugin says so). That one
    // keeps its note as it was — re-stamping moved it past sign-ins sent since, and renewed its minute on
    // every reload while it kept failing — and stands down if a sign-in was sent after it, in any tab:
    // sending would end that newer session. Only a recorded sign-in, never a note that's gone: one that
    // aged out or another logout cleared still has a session to end. Any other call is a new logout.
    const finishing = state.finishingLogout
    state.finishingLogout = undefined
    const moot = () => finishing !== undefined && signedInSince(state.scope, finishing)
    if (import.meta.client && finishing === undefined) notePendingLogout(state.scope)

    let early: Promise<boolean> | null = null
    let sentInOrder = false
    const leaving = () => {
      if (early || sentInOrder || moot()) return
      early = $lukk.logout({ retry: false }).then(() => true, () => false)
    }
    const hidden = () => {
      if (document.visibilityState === 'hidden') leaving()
    }
    const page = import.meta.client && typeof window !== 'undefined' && typeof window.addEventListener === 'function' ? window : undefined
    const doc = page && typeof document !== 'undefined' ? document : undefined
    page?.addEventListener('pagehide', leaving)
    doc?.addEventListener('visibilitychange', hidden)

    const ending = acrossTabs(nuxtApp, () => endAndClear(async () => {
      // Sent on the way out: send it again only if that attempt failed — a page restored from the
      // back/forward cache resumes here, and a lost early send would otherwise leave the session live.
      // A sign-in sent after the logout this finishes comes first, even over a failed early send: resending
      // would end that newer session.
      if (moot()) return false
      if (early) return !(await early)
      sentInOrder = true
      return true
    }))
    state.ending = ending
    try {
      await ending
      clearPendingLogout(state.scope)
    }
    catch (error) {
      // No session left to end: done. Anything else may have left it live — keep the note, so the next
      // page load in this tab tries again.
      if ((error as { status?: number } | null)?.status === 401) clearPendingLogout(state.scope)
      throw error
    }
    finally {
      page?.removeEventListener('pagehide', leaving)
      doc?.removeEventListener('visibilitychange', hidden)
      if (state.ending === ending) state.ending = null
    }
  }

  /** `claimSend` says whether this logout should still send its request — not when the page already did. */
  async function endAndClear(claimSend: () => Promise<boolean>): Promise<void> {
    try {
      // Let a refresh already on the wire finish first, so its cookie cannot land after logout cleared
      // the session — and so the logout itself carries the token it just minted.
      await settleRefresh(nuxtApp)
      // Then end the generation BEFORE sending: a restore, refresh, user load or sign-in still out must
      // not write its result after this.
      state.epoch++
      state.logouts++
      // Unless the page already sent it on its way out.
      if (await claimSend()) await endSession()
    }
    finally {
      // Once more: the renewal inside `endSession` can itself start a user reload, which captured the
      // generation bumped above — landing after this, it put the user back, signed in with no token.
      state.epoch++
      access.value = null
      user.value = null
      state.subject = undefined
      restoreFailedFlag.value = false
      challenge.value = null
      confirmation.value = null
      confirmed.value = false
      state.announce?.()
    }
  }

  /**
   * Send the logout, renewing an expired access token once if lukk rejects it.
   *
   * Not lukk-core's own refresh-and-retry: each attempt is published as the handover, and a refresh waits
   * for the handover — so core's refresh waited on the logout that was waiting for it, and every logout
   * with an expired token (an idle user, an erased account) hung for the full settle timeout.
   *
   * The hold is per ATTEMPT. Between the rejected attempt and the retry there is none, so the renewal —
   * or a refresh another request already started while the first attempt was out, which the renewal then
   * joins — goes out at once. Holding it across the gap made that joined refresh wait on this logout
   * again. Sign-ins stay out of the gap by waiting on the whole `logout()` (`state.ending`).
   *
   * The renewal still costs a round trip before the retry. A page that navigates away without awaiting
   * `logout()` can cancel it — then lukk never revokes the session. Await it before navigating.
   */
  async function endSession(): Promise<void> {
    try {
      await sendLogout()
    }
    catch (error) {
      if ((error as { status?: number } | null)?.status !== 401) throw error

      const renewed = await (nuxtApp as { $lukkRefresh?: () => Promise<unknown> }).$lukkRefresh?.()
      if (!renewed) throw error
      await sendLogout()
    }
  }

  async function sendLogout(): Promise<void> {
    const request = $lukk.logout({ retry: false })
    state.handover = request
    try { await request }
    finally { if (state.handover === request) state.handover = null }
  }

  /** Revoke every *other* session (e.g. after a password change). */
  async function revokeOtherSessions(): Promise<void> {
    await $lukk.revokeOtherSessions()
  }

  /**
   * Load the current user from the app's own endpoint (lukk issues the token;
   * the app owns the user resource).
   *  - direct: the access token is attached as a Bearer header.
   *  - bff: the browser has no token, so `user.endpoint` MUST be a same-origin
   *    path authenticated server-side (the app-API proxy, or your own route using
   *    `getLukkAccessToken(event)`) — no header is attached here.
   *
   * On error, only a 401/403 logs the user out; a transient 5xx/network failure
   * leaves the current `user` intact (don't bounce a logged-in user to /login).
   */
  async function fetchUser(): Promise<void> {
    // A `logout()` or a sign-in while this is in flight makes its answer stale — a user loaded for the
    // session that just ended would otherwise sign the visitor back in.
    const epoch = state.epoch
    await loadUser(() => epoch === state.epoch)
  }

  /**
   * `fetchUser`, reporting how it went — so a restore can tell "the user endpoint said you are signed
   * out" from "the user endpoint failed". `fetchUser` keeps its `Promise<void>` signature.
   */
  async function loadUser(isCurrent: () => boolean): Promise<'loaded' | 'signed-out' | 'unavailable' | 'skipped' | 'stale'> {
    if (!cfg.userEndpoint) return 'skipped'
    try {
      // userEndpoint is a full path; `baseURL: ''` keeps it as-is (in server-BFF the
      // request-aware transport resolves the relative endpoint in-process). `shapeUser`
      // auto-unwraps a Laravel `{ data: {...} }` API-Resource wrapper (configurable via `user.key`).
      const body = await api(cfg.userEndpoint, { baseURL: '' })
      if (!isCurrent()) return 'stale'
      user.value = shapeUser(body, cfg.userKey || false)
      restoreFailedFlag.value = false
      state.subject = tokenSubject(access.value)
      // Dev-only: nudge the developer if the endpoint shape wasn't handled (no `id`, still wrapped).
      if (import.meta.dev) {
        const warning = userShapeWarning(user.value)
        if (warning) console.warn(warning)
      }
      return 'loaded'
    }
    catch (e) {
      // Only an auth failure means "logged out". A transient 5xx/network error
      // must not flip `loggedIn` and bounce a logged-in user to /login.
      if (!isAuthRejection(e)) return 'unavailable'
      if (!isCurrent()) return 'stale'
      user.value = null
      restoreFailedFlag.value = false
      state.subject = undefined
      return 'signed-out'
    }
  }

  /**
   * Silently restore a session on app load (a valid refresh → logged in). Goes through the shared
   * single-flight refresh (`$lukkRestore`) so a boot restore can't race a concurrent app-API 401
   * refresh and replay the rotating token twice. Also the retry after {@link restoreFailed}.
   */
  async function initSession(): Promise<void> {
    const epoch = state.epoch
    const isCurrent = () => epoch === state.epoch

    // Read at CALL time, like `useLukkFetch` does — a `useLukkAuth()` created before the client plugin
    // provided it would otherwise keep `undefined` forever and silently never restore. No provide at
    // all (an ordering gap, a failed plugin) degrades to signed-out, not to "unavailable", which would
    // invite a retry loop that can never succeed.
    const restore = (nuxtApp as { $lukkRestore?: () => Promise<RestoreOutcome> }).$lukkRestore
    const outcome = await restore?.()

    // A `logout()` or sign-in ran while this was in flight: its answer is newer than ours.
    if (!isCurrent() || outcome?.superseded) return

    if (!outcome?.pair) {
      // "No session" is an answer about the visitor, so clear a user still on screen — a retry from a tab
      // whose session another tab logged out kept showing that account. Not when it merely couldn't tell.
      if (outcome && !outcome.unavailable) user.value = null
      restoreFailedFlag.value = outcome?.unavailable ?? false
      return
    }

    const loaded = await loadUser(isCurrent)
    // Set from the result, not only ever to `true`: a retry whose refresh succeeded on an app with no
    // user endpoint (`skipped`) is a definitive answer and must clear an earlier failure.
    if (isCurrent()) restoreFailedFlag.value = loaded === 'unavailable'
  }

  /**
   * Resolve once {@link ready} is true — for code that may run BEFORE the restore finishes: a store, a
   * composable used from a plugin, anything not tied to route middleware or a component (which Nuxt
   * already runs after the restore).
   *
   * **On the server it resolves immediately**: the client restore never runs there, so an unhydrated
   * render would wait forever. Read `ready` afterwards: on the server it can still be `false`, meaning
   * "unknown — the client will decide", which is not the same as anonymous.
   *
   * **Do not await it in the setup of a plugin that runs before `lukk:session-restore`** — plugins run
   * in sequence, so that plugin can wait on one that cannot start until it returns, and the app never
   * boots. Put such a plugin in a `.client.ts` file with `dependsOn: ['lukk:session-restore']` (the
   * restore plugin is client-only, so a universal plugin naming it is reported — logged as an error during
   * a Nuxt 3 build, which still succeeds; a development warning on Nuxt 4). Warned about in
   * development.
   */
  function whenReady(): Promise<void> {
    const isServer = import.meta.server === true

    if (import.meta.dev) {
      if (isPrematureWait(ready.value, isServer, state.started)) {
        console.warn('[lukk-nuxt] whenReady() was called before the session-restore plugin started. Awaiting it in a plugin\'s setup can deadlock app startup — move that plugin to a `.client.ts` file with `dependsOn: [\'lukk:session-restore\']`. Depending on `lukk:client` is not enough.')
      }
    }

    return settled(ready, isServer)
  }

  return { user, loggedIn, ready, whenReady, restoreFailed, pendingTwoFactor, register, login, verifyTwoFactor, verifyRecoveryCode, logout, revokeOtherSessions, fetchUser, initSession }
}

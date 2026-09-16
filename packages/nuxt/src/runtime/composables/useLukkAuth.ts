import { isRegistrationPending, isTwoFactorChallenge, type LoginInput, type LoginResult, type LukkUser, type RegisterInput, type RegisterResult, shapeUser, type TokenPair, userShapeWarning } from 'lukk-core'
import { computed, useNuxtApp, useRuntimeConfig, useState } from '#imports'
import { ACCESS_KEY, CHALLENGE_KEY, CONFIRMATION_KEY, CONFIRMED_KEY, READY_KEY, RESTORE_FAILED_KEY, USER_KEY } from '../keys'
import { isAuthRejection } from '../shared'
import { whenReady as settled } from '../utils/when-ready'
import { useLukkFetch } from './useLukkFetch'

interface PublicLukk {
  mode: 'bff' | 'direct'
  baseURL: string
  confirmationHeader: string
  userEndpoint: string
  userKey: string
}

/**
 * The reactive auth surface. Identical API in every mode — only the transport
 * underneath differs.
 */
export function useLukkAuth() {
  const nuxtApp = useNuxtApp()
  const { $lukk } = nuxtApp
  // `$lukkRefresh` is provided by the universal client plugin. Read it as optional (like
  // `useLukkFetch` does) so a not-yet-in-effect provide — an ordering gap on hydration, or a
  // failed plugin setup — degrades to logged-out instead of a fatal `$lukkRefresh is not a function`.
  // `$lukkRestore` is the same single-flight refresh, reporting why a refresh failed (see plugins/client).
  const $lukkRestore = (nuxtApp as { $lukkRestore?: () => Promise<{ pair: TokenPair | null, unavailable: boolean }> }).$lukkRestore
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

  const loggedIn = computed(() => user.value !== null)
  const pendingTwoFactor = computed(() => challenge.value !== null)

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
   *  - **During a server render that did not hydrate a user.** Direct mode (the server never sees
   *    the refresh cookie), `ssrHydrate: false`, a prerendered route, or a session the server could
   *    not rotate. The server cannot tell these from an anonymous visitor, so it does not claim to.
   *  - **In any plugin that runs before, or in parallel with, `lukk:session-restore`.**
   *
   * On the client it is `true` by the time route middleware, component `setup()` and `onMounted`
   * run: Nuxt awaits the restore plugin before the initial navigation and before mounting. It is
   * `true` from the start when the server hydrated the user, so that path stays synchronous.
   *
   * `ready` means the restore FINISHED, not that it reached an answer — see {@link restoreFailed}.
   */
  const ready = computed(() => readyFlag.value)

  const restoreFailedFlag = useState<boolean>(RESTORE_FAILED_KEY, () => false)

  /**
   * True when the last restore could not reach an answer, so nobody is signed in but the visitor
   * may well have a valid session: the refresh was throttled (429), the server errored (5xx) or was
   * unreachable, or the refresh worked and the user endpoint then failed the same way.
   *
   * Only a 401/403 means "no session" — the rule `fetchUser` already used. Show a "couldn't reach
   * the server, retry" state here rather than a login prompt, and retry with `initSession()`.
   *
   * Hidden while someone is signed in, and cleared by `logout()` — both are definitive answers.
   */
  const restoreFailed = computed(() => restoreFailedFlag.value && !loggedIn.value)

  /**
   * Password login. When the user has 2FA enabled this surfaces a challenge
   * (`pendingTwoFactor` becomes true) instead of logging in — complete it with
   * `verifyTwoFactor` / `verifyRecoveryCode`. Otherwise the token is persisted
   * and the user loaded.
   */
  async function login(credentials: LoginInput): Promise<LoginResult> {
    const result = await $lukk.login(credentials)
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
    const result = await $lukk.register(input)
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
    await $lukk.twoFactorChallenge({ challenge_token: challenge.value, ...input })
    challenge.value = null
    await fetchUser()
  }

  async function logout(): Promise<void> {
    try { await $lukk.logout() }
    finally {
      access.value = null
      user.value = null
      restoreFailedFlag.value = false
      challenge.value = null
      confirmation.value = null
      confirmed.value = false
    }
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
    await loadUser()
  }

  /**
   * `fetchUser`, reporting how it went — so a restore can tell "the user endpoint said you are signed
   * out" from "the user endpoint failed". `fetchUser` keeps its `Promise<void>` signature.
   */
  async function loadUser(): Promise<'loaded' | 'signed-out' | 'unavailable' | 'skipped'> {
    if (!cfg.userEndpoint) return 'skipped'
    try {
      // userEndpoint is a full path; `baseURL: ''` keeps it as-is (in server-BFF the
      // request-aware transport resolves the relative endpoint in-process). `shapeUser`
      // auto-unwraps a Laravel `{ data: {...} }` API-Resource wrapper (configurable via `user.key`).
      user.value = shapeUser(await api(cfg.userEndpoint, { baseURL: '' }), cfg.userKey || false)
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
      user.value = null
      return 'signed-out'
    }
  }

  /**
   * Silently restore a session on app load (a valid refresh → logged in). Goes through
   * the shared single-flight `$lukkRefresh` so a boot restore can't race a concurrent
   * app-API 401 refresh and replay the rotating token twice.
   */
  async function initSession(): Promise<void> {
    // No provide at all (an ordering gap, a failed plugin) degrades to signed-out, as before — not to
    // "unavailable", which would invite a retry loop that can never succeed.
    const outcome = await $lukkRestore?.()

    if (!outcome?.pair) {
      restoreFailedFlag.value = outcome?.unavailable ?? false
      return
    }

    restoreFailedFlag.value = (await loadUser()) === 'unavailable'
  }

  /**
   * Resolve once {@link ready} is true. For client code — `onMounted`, a watcher, an event handler.
   *
   * **On the server it resolves immediately**, because nothing later in the request can settle the
   * session and waiting would hang the render. Read `ready` afterwards: on the server it can still
   * be `false`, meaning "unknown — the client will decide", which is not the same as anonymous.
   */
  function whenReady(): Promise<void> {
    return settled(readyFlag, import.meta.server === true)
  }

  return { user, loggedIn, ready, whenReady, restoreFailed, pendingTwoFactor, register, login, verifyTwoFactor, verifyRecoveryCode, logout, revokeOtherSessions, fetchUser, initSession }
}

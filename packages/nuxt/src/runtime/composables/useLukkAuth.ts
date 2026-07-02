import { isTwoFactorChallenge, type LoginInput, type LoginResult, type LukkUser, shapeUser, userShapeWarning } from 'lukk-core'
import { computed, useNuxtApp, useRuntimeConfig, useState } from '#imports'
import { ACCESS_KEY, CHALLENGE_KEY, CONFIRMATION_KEY, CONFIRMED_KEY, USER_KEY } from '../keys'
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
  const $lukkRefresh = (nuxtApp as { $lukkRefresh?: () => Promise<unknown> }).$lukkRefresh
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

  /**
   * Password login. When the user has 2FA enabled this surfaces a challenge
   * (`pendingTwoFactor` becomes true) instead of logging in — complete it with
   * `verifyTwoFactor` / `verifyRecoveryCode`. Otherwise the token is persisted
   * and the user loaded.
   */
  async function login(credentials: LoginInput): Promise<LoginResult> {
    const result = await $lukk.login(credentials)
    if (isTwoFactorChallenge(result)) {
      challenge.value = result.challenge_token
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
    if (!cfg.userEndpoint) return
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
    }
    catch (e) {
      // Only an auth failure means "logged out". A transient 5xx/network error
      // must not flip `loggedIn` and bounce a logged-in user to /login.
      const status = (e as { statusCode?: number, status?: number }).statusCode ?? (e as { status?: number }).status
      if (status === 401 || status === 403) user.value = null
    }
  }

  /**
   * Silently restore a session on app load (a valid refresh → logged in). Goes through
   * the shared single-flight `$lukkRefresh` so a boot restore can't race a concurrent
   * app-API 401 refresh and replay the rotating token twice.
   */
  async function initSession(): Promise<void> {
    const pair = (await $lukkRefresh?.()) ?? null
    if (pair) await fetchUser()
  }

  return { user, loggedIn, pendingTwoFactor, login, verifyTwoFactor, verifyRecoveryCode, logout, revokeOtherSessions, fetchUser, initSession }
}

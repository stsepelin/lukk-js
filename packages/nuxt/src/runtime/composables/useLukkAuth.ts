import { isTwoFactorChallenge, type LoginCredentials, type LoginResult } from 'lukk-core'
import { computed, useNuxtApp, useRuntimeConfig, useState } from '#imports'
import { ACCESS_KEY, CHALLENGE_KEY, CONFIRMATION_KEY, CONFIRMED_KEY, USER_KEY } from '../keys'

interface PublicLukk {
  mode: 'bff' | 'direct'
  baseURL: string
  confirmationHeader: string
  userEndpoint: string
}

/**
 * The reactive auth surface. Identical API in every mode — only the transport
 * underneath differs.
 */
export function useLukkAuth() {
  const { $lukk } = useNuxtApp()
  const cfg = useRuntimeConfig().public.lukk as PublicLukk

  // Shared with the client plugin (`onTokens` writes the access token here).
  const access = useState<string | null>(ACCESS_KEY, () => null)
  const user = useState<unknown | null>(USER_KEY, () => null)
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
  async function login(credentials: LoginCredentials): Promise<LoginResult> {
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
   * the app owns the user resource). Resolves against the app origin, with the
   * access token attached in direct mode.
   */
  async function fetchUser(): Promise<void> {
    if (!cfg.userEndpoint) return
    const headers: Record<string, string> = access.value ? { Authorization: `Bearer ${access.value}` } : {}
    try {
      user.value = await $fetch(cfg.userEndpoint, { headers })
    }
    catch (e) {
      // Only an auth failure means "logged out". A transient 5xx/network error
      // must not flip `loggedIn` and bounce a logged-in user to /login.
      const status = (e as { statusCode?: number, status?: number }).statusCode ?? (e as { status?: number }).status
      if (status === 401 || status === 403) user.value = null
    }
  }

  /** Silently restore a session on app load (a valid refresh cookie → logged in). */
  async function initSession(): Promise<void> {
    const pair = await $lukk.restore()
    if (pair) await fetchUser()
  }

  return { user, loggedIn, pendingTwoFactor, login, verifyTwoFactor, verifyRecoveryCode, logout, revokeOtherSessions, fetchUser, initSession }
}

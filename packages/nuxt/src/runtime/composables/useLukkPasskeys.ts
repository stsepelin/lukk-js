import { credentialToJSON, isTwoFactorChallenge, type LoginResult, type PasskeyLoginOptions, type PasskeySummary, toCreationOptions, toRequestOptions } from 'lukk-core'
import { useNuxtApp, useState } from '#imports'
import { CHALLENGE_KEY } from '../keys'
import { signIn } from '../utils/restore-state'
import { useLukkAuth } from './useLukkAuth'
import { useLukkConfirmation } from './useLukkConfirmation'

/**
 * Declared rather than inferred: the module build cannot resolve `#imports`, so an inferred return type
 * shipped as `any` in the published declarations — `list()` and `remove()` returned `any`.
 */
export interface LukkPasskeys {
  register: (name?: string) => Promise<void>
  login: () => Promise<LoginResult>
  confirm: () => Promise<void>
  list: () => Promise<{ passkeys: PasskeySummary[] }>
  remove: (id: string) => Promise<void>
}

/**
 * Passkeys (WebAuthn). Drives the browser ceremony (`navigator.credentials`)
 * and lukk-core's base64url (de)serialization, so callers just await a verb.
 */
export function useLukkPasskeys(): LukkPasskeys {
  const nuxtApp = useNuxtApp()
  const { $lukk } = nuxtApp

  /** Register a new passkey (requires a logged-in, step-up-confirmed user). */
  async function register(name?: string): Promise<void> {
    const options = await $lukk.passkeyRegistrationOptions()
    const credential = await navigator.credentials.create({ publicKey: toCreationOptions(options) }) as PublicKeyCredential
    await $lukk.registerPasskey(credentialToJSON(credential), name)
  }

  /**
   * Passwordless login with a passkey, then load the user. A single-factor assertion on an account
   * with confirmed two-factor gets a challenge instead (lukk ≥ 0.7): `pendingTwoFactor` turns true and
   * `useLukkAuth().verifyTwoFactor()` completes it, as after a password sign-in.
   */
  async function login(): Promise<LoginResult> {
    const assertion = await assert()
    // The same session handover as a password login — see `useLukkAuth().login`.
    const { result, current } = await signIn(nuxtApp, () => $lukk.loginWithPasskey(assertion.ceremony_id, assertion.credential), r => !isTwoFactorChallenge(r))
    const auth = useLukkAuth()

    if (isTwoFactorChallenge(result)) {
      // No session was issued, so a logout meanwhile leaves nothing to end — only the challenge to drop.
      // Client-only, as in `useLukkAuth().login`: a challenge written during SSR would serialise into
      // the page payload.
      if (current) {
        // Stryker disable next-line ConditionalExpression,ArrowFunction: the mutation run compiles the client, where `import.meta.client` is `true` already, and the initial value is overwritten on the same line.
        if (import.meta.client) useState<string | null>(CHALLENGE_KEY, () => null).value = result.challenge_token
      }
      return result
    }

    // Logged out while the response was on the wire: end the session it just issued.
    if (!current) {
      await auth.logout()
      return result
    }
    await auth.fetchUser()
    return result
  }

  /** Earn step-up confirmation with a passkey (recorded via `useLukkConfirmation`). */
  async function confirm(): Promise<void> {
    const confirmation = useLukkConfirmation()

    try {
      const assertion = await assert(stepUpOptions)
      confirmation.record(await $lukk.confirmPasskey(assertion.ceremony_id, assertion.credential))
    }
    catch (error) {
      // Same as the password path: a 403 is "this token may never earn a confirmation", so the
      // pending step-up must be abandoned rather than left waiting for a flag that cannot flip.
      confirmation.abandonIfUnearnable(error)
      throw error
    }
  }

  /** List the user's passkeys. */
  function list(): Promise<{ passkeys: PasskeySummary[] }> {
    return $lukk.listPasskeys()
  }

  /** Remove a passkey by credential id. */
  function remove(id: string): Promise<void> {
    return $lukk.deletePasskey(id)
  }

  /**
   * The step-up's own options, which carry the user-verification requirement lukk will enforce. A
   * lukk that predates the route answers 404, and only then do the anonymous login options stand in.
   */
  async function stepUpOptions(): Promise<PasskeyLoginOptions> {
    try {
      return await $lukk.passkeyConfirmationOptions()
    }
    catch (error) {
      if ((error as { status?: number }).status !== 404) throw error
      return $lukk.passkeyLoginOptions()
    }
  }

  /** Run the assertion ceremony once (shared by login + confirm). */
  async function assert(options_: () => Promise<PasskeyLoginOptions> = () => $lukk.passkeyLoginOptions()): Promise<{ ceremony_id: string, credential: Record<string, unknown> }> {
    const { ceremony_id, options } = await options_()
    const credential = await navigator.credentials.get({ publicKey: toRequestOptions(options) }) as PublicKeyCredential
    return { ceremony_id, credential: credentialToJSON(credential) }
  }

  return { register, login, confirm, list, remove }
}

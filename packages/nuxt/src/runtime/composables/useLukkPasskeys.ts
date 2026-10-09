import { credentialToJSON, type LoginResult, type PasskeyLoginOptions, type PasskeySummary, toCreationOptions, toRequestOptions } from 'lukk-core'
import { useNuxtApp } from '#imports'
import { SIGN_IN, type SignInWith } from '../utils/sign-in'
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
 * `navigator.credentials.create()`/`get()` may resolve to null; serialising that threw a TypeError deep
 * in the conversion, with nothing to say what happened.
 */
function present(credential: PublicKeyCredential | null): PublicKeyCredential {
  if (!credential) throw new Error('lukk: the browser returned no passkey credential')
  return credential
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
    const credential = present(await navigator.credentials.create({ publicKey: toCreationOptions(options) }) as PublicKeyCredential | null)
    await $lukk.registerPasskey(credentialToJSON(credential), name)
  }

  /**
   * Passwordless login with a passkey, then load the user. A single-factor assertion on an account
   * with confirmed two-factor gets a challenge instead (lukk ≥ 0.7): `pendingTwoFactor` turns true and
   * `useLukkAuth().verifyTwoFactor()` completes it, as after a password sign-in.
   */
  async function login(): Promise<LoginResult> {
    const assertion = await assert()
    // The password sign-in's own completion: the same handover, challenge handling and — when a logout
    // overtook it — the same logout of its own for the session it issued.
    const signInWith = (useLukkAuth() as unknown as Record<typeof SIGN_IN, SignInWith>)[SIGN_IN]
    return signInWith(() => $lukk.loginWithPasskey(assertion.ceremony_id, assertion.credential))
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
    const credential = present(await navigator.credentials.get({ publicKey: toRequestOptions(options) }) as PublicKeyCredential | null)
    return { ceremony_id, credential: credentialToJSON(credential) }
  }

  return { register, login, confirm, list, remove }
}

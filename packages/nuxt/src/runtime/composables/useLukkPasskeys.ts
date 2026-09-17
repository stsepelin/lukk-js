import { credentialToJSON, type PasskeySummary, toCreationOptions, toRequestOptions } from 'lukk-core'
import { useNuxtApp } from '#imports'
import { signIn } from '../utils/restore-state'
import { useLukkAuth } from './useLukkAuth'
import { useLukkConfirmation } from './useLukkConfirmation'

/**
 * Declared rather than inferred: the module build cannot resolve `#imports`, so an inferred return type
 * shipped as `any` in the published declarations — `list()` and `remove()` returned `any`.
 */
export interface LukkPasskeys {
  register: (name?: string) => Promise<void>
  login: () => Promise<void>
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

  /** Passwordless login with a passkey, then load the user. */
  async function login(): Promise<void> {
    const assertion = await assert()
    // The same session handover as a password login — see `useLukkAuth().login`.
    const { current } = await signIn(nuxtApp, () => $lukk.loginWithPasskey(assertion.ceremony_id, assertion.credential), () => true)
    const auth = useLukkAuth()
    // Logged out while the response was on the wire: end the session it just issued.
    if (!current) return auth.logout()
    await auth.fetchUser()
  }

  /** Earn step-up confirmation with a passkey (recorded via `useLukkConfirmation`). */
  async function confirm(): Promise<void> {
    const assertion = await assert()
    const confirmation = useLukkConfirmation()

    try {
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

  /** Run the assertion ceremony once (shared by login + confirm). */
  async function assert(): Promise<{ ceremony_id: string, credential: Record<string, unknown> }> {
    const { ceremony_id, options } = await $lukk.passkeyLoginOptions()
    const credential = await navigator.credentials.get({ publicKey: toRequestOptions(options) }) as PublicKeyCredential
    return { ceremony_id, credential: credentialToJSON(credential) }
  }

  return { register, login, confirm, list, remove }
}

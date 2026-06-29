import { credentialToJSON, toCreationOptions, toRequestOptions } from 'lukk-core'
import { useNuxtApp } from '#imports'
import { useLukkAuth } from './useLukkAuth'
import { useLukkConfirmation } from './useLukkConfirmation'

/**
 * Passkeys (WebAuthn). Drives the browser ceremony (`navigator.credentials`)
 * and lukk-core's base64url (de)serialization, so callers just await a verb.
 */
export function useLukkPasskeys() {
  const { $lukk } = useNuxtApp()

  /** Register a new passkey (requires a logged-in, step-up-confirmed user). */
  async function register(name?: string): Promise<void> {
    const options = await $lukk.passkeyRegistrationOptions()
    const credential = await navigator.credentials.create({ publicKey: toCreationOptions(options) }) as PublicKeyCredential
    await $lukk.registerPasskey(credentialToJSON(credential), name)
  }

  /** Passwordless login with a passkey, then load the user. */
  async function login(): Promise<void> {
    const assertion = await assert()
    await $lukk.loginWithPasskey(assertion.ceremony_id, assertion.credential)
    await useLukkAuth().fetchUser()
  }

  /** Earn step-up confirmation with a passkey (recorded via `useLukkConfirmation`). */
  async function confirm(): Promise<void> {
    const assertion = await assert()
    useLukkConfirmation().record(await $lukk.confirmPasskey(assertion.ceremony_id, assertion.credential))
  }

  /** List the user's passkeys. */
  function list() {
    return $lukk.listPasskeys()
  }

  /** Remove a passkey by credential id. */
  function remove(id: string) {
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

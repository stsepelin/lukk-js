import { afterEach, describe, expect, it, vi } from 'vitest'
import { __test } from './mocks/imports'

import { useLukkConfirmation } from '../src/runtime/composables/useLukkConfirmation'

import { useLukkPasskeys } from '../src/runtime/composables/useLukkPasskeys'
import { useLukkSecret } from '../src/runtime/utils/secrets'

// The serialization helpers are 100%-tested in lukk-core; here we test orchestration.
vi.mock('lukk-core', () => ({
  toCreationOptions: (json: unknown) => ({ creation: json }),
  toRequestOptions: (json: unknown) => ({ request: json }),
  credentialToJSON: (cred: { id: string }) => ({ serialized: cred.id }),
}))

// The sign-in itself — handover, challenge, superseded logout — is useLukkAuth's, shared with the
// password path and tested with the real composable in session-generation and logout-paths.
const signInWith = vi.fn((send: () => Promise<unknown>) => send())
vi.mock('../src/runtime/composables/useLukkAuth', async () => {
  const { SIGN_IN } = await import('../src/runtime/utils/sign-in')
  return { useLukkAuth: () => ({ [SIGN_IN]: signInWith }) }
})

function withNavigator(create = vi.fn(), get = vi.fn()) {
  vi.stubGlobal('navigator', { credentials: { create, get } })
}

afterEach(() => { __test.reset(); vi.clearAllMocks(); vi.unstubAllGlobals() })

describe('useLukkPasskeys', () => {
  it('registers a passkey', async () => {
    const $lukk = {
      passkeyRegistrationOptions: vi.fn().mockResolvedValue({ challenge: 'c' }),
      registerPasskey: vi.fn().mockResolvedValue(undefined),
    }
    __test.nuxtApp = { $lukk }
    const create = vi.fn().mockResolvedValue({ id: 'cred-1' })
    withNavigator(create)

    await useLukkPasskeys().register('My Key')

    expect(create).toHaveBeenCalledWith({ publicKey: { creation: { challenge: 'c' } } })
    expect($lukk.registerPasskey).toHaveBeenCalledWith({ serialized: 'cred-1' }, 'My Key')
  })

  it('signs in through the shared sign-in, sending the assertion it made', async () => {
    const answer = { two_factor: true, challenge_token: 'ct' }
    const $lukk = {
      passkeyLoginOptions: vi.fn().mockResolvedValue({ ceremony_id: 'cer', options: { challenge: 'c' } }),
      loginWithPasskey: vi.fn().mockResolvedValue(answer),
    }
    __test.nuxtApp = { $lukk }
    const get = vi.fn().mockResolvedValue({ id: 'cred-2' })
    withNavigator(vi.fn(), get)

    await expect(useLukkPasskeys().login()).resolves.toBe(answer)

    expect(get).toHaveBeenCalledWith({ publicKey: { request: { challenge: 'c' } } })
    expect(signInWith).toHaveBeenCalledOnce()
    expect($lukk.loginWithPasskey).toHaveBeenCalledWith('cer', { serialized: 'cred-2' })
  })

  it('makes the assertion before the sign-in starts, so a cancelled prompt signs nobody in', async () => {
    const $lukk = { passkeyLoginOptions: vi.fn().mockResolvedValue({ ceremony_id: 'cer', options: { challenge: 'c' } }), loginWithPasskey: vi.fn() }
    __test.nuxtApp = { $lukk }
    withNavigator(vi.fn(), vi.fn().mockRejectedValue(new Error('NotAllowedError')))

    await expect(useLukkPasskeys().login()).rejects.toThrow('NotAllowedError')
    expect(signInWith).not.toHaveBeenCalled()
  })

  it('earns step-up confirmation with a passkey', async () => {
    const $lukk = {
      passkeyConfirmationOptions: vi.fn().mockResolvedValue({ ceremony_id: 'cer', options: { challenge: 'c' } }),
      confirmPasskey: vi.fn().mockResolvedValue({ confirmation_token: 'tok' }),
    }
    __test.nuxtApp = { $lukk }
    withNavigator(vi.fn(), vi.fn().mockResolvedValue({ id: 'cred-3' }))

    await useLukkPasskeys().confirm()

    expect($lukk.confirmPasskey).toHaveBeenCalledWith('cer', { serialized: 'cred-3' })
    expect(useLukkSecret('confirmation').value).toBe('tok')
  })

  it('lists and removes passkeys', async () => {
    const $lukk = {
      listPasskeys: vi.fn().mockResolvedValue({ passkeys: [{ id: 'p1', name: 'Key', last_used_at: null }] }),
      deletePasskey: vi.fn().mockResolvedValue(undefined),
    }
    __test.nuxtApp = { $lukk }
    const pk = useLukkPasskeys()

    expect(await pk.list()).toEqual({ passkeys: [{ id: 'p1', name: 'Key', last_used_at: null }] })
    await pk.remove('p1')
    expect($lukk.deletePasskey).toHaveBeenCalledWith('p1')
  })
})

describe('passkey step-up options', () => {
  // lukk asks a step-up for `userVerification: required` whenever the account can reach AAL2, and
  // lists the user's own credentials — only its authenticated options route knows that. The anonymous
  // login options ask for less, and lukk refuses an assertion made against them on such an account.

  it('asks the step-up options route, not the anonymous login one', async () => {
    const $lukk = {
      passkeyConfirmationOptions: vi.fn().mockResolvedValue({ ceremony_id: 'step', options: { challenge: 'c' } }),
      passkeyLoginOptions: vi.fn(),
      confirmPasskey: vi.fn().mockResolvedValue({ confirmation_token: 'tok' }),
    }
    __test.nuxtApp = { $lukk }
    withNavigator(vi.fn(), vi.fn().mockResolvedValue({ id: 'cred-6' }))

    await useLukkPasskeys().confirm()

    expect($lukk.passkeyLoginOptions).not.toHaveBeenCalled()
    expect($lukk.confirmPasskey).toHaveBeenCalledWith('step', { serialized: 'cred-6' })
  })

  it('falls back to the login options on a lukk that predates the route', async () => {
    const $lukk = {
      passkeyConfirmationOptions: vi.fn().mockRejectedValue({ status: 404 }),
      passkeyLoginOptions: vi.fn().mockResolvedValue({ ceremony_id: 'old', options: { challenge: 'c' } }),
      confirmPasskey: vi.fn().mockResolvedValue({ confirmation_token: 'tok' }),
    }
    __test.nuxtApp = { $lukk }
    withNavigator(vi.fn(), vi.fn().mockResolvedValue({ id: 'cred-7' }))

    await useLukkPasskeys().confirm()

    expect($lukk.confirmPasskey).toHaveBeenCalledWith('old', { serialized: 'cred-7' })
  })

  it('does not fall back on any other failure', async () => {
    const $lukk = {
      passkeyConfirmationOptions: vi.fn().mockRejectedValue({ status: 429 }),
      passkeyLoginOptions: vi.fn(),
      confirmPasskey: vi.fn(),
    }
    __test.nuxtApp = { $lukk }
    withNavigator(vi.fn(), vi.fn())

    await expect(useLukkPasskeys().confirm()).rejects.toMatchObject({ status: 429 })
    expect($lukk.passkeyLoginOptions).not.toHaveBeenCalled()
  })

  it('abandons the pending confirmation when the options route itself is forbidden', async () => {
    // The options route carries the same pinned-ability gate as `confirm-passkey`, so for a machine
    // token the 403 now arrives one step earlier — and must still release the modal.
    __test.nuxtApp = { $lukk: { passkeyConfirmationOptions: vi.fn().mockRejectedValue({ status: 403 }), confirmPasskey: vi.fn() } }
    withNavigator(vi.fn(), vi.fn())

    const { required } = useLukkConfirmation()
    required.value = true

    await expect(useLukkPasskeys().confirm()).rejects.toMatchObject({ status: 403 })
    expect(required.value).toBe(false)
  })
})

describe('passkey step-up a pinned token cannot earn', () => {
  it('abandons the pending confirmation on a 403, like the password path', async () => {
    // `confirm-passkey` is the OTHER way into step-up, and lukk gates both for a machine token.
    // Handling only the password path would leave this one deadlocking the modal: `withConfirmation`
    // waits on a `confirmed` flag that can never flip for a token lacking `lukk.account`.
    __test.nuxtApp = {
      $lukk: {
        passkeyConfirmationOptions: vi.fn().mockResolvedValue({ ceremony_id: 'cer', options: { challenge: 'c' } }),
        confirmPasskey: vi.fn().mockRejectedValue({ status: 403 }),
      },
    }
    withNavigator(vi.fn(), vi.fn().mockResolvedValue({ id: 'cred-4' }))

    const { required } = useLukkConfirmation()
    required.value = true

    await expect(useLukkPasskeys().confirm()).rejects.toMatchObject({ status: 403 })

    expect(required.value).toBe(false)
  })

  it('leaves a pending confirmation alone when the assertion is merely rejected', async () => {
    __test.nuxtApp = {
      $lukk: {
        passkeyConfirmationOptions: vi.fn().mockResolvedValue({ ceremony_id: 'cer', options: { challenge: 'c' } }),
        confirmPasskey: vi.fn().mockRejectedValue({ status: 422 }),
      },
    }
    withNavigator(vi.fn(), vi.fn().mockResolvedValue({ id: 'cred-5' }))

    const { required } = useLukkConfirmation()
    required.value = true

    await expect(useLukkPasskeys().confirm()).rejects.toMatchObject({ status: 422 })

    expect(required.value).toBe(true)
  })
})

describe('a browser that hands back no credential', () => {
  // `navigator.credentials.create()`/`get()` may resolve to null. Serialising that threw a TypeError deep in
  // the conversion, with nothing to say what happened.
  it('fails registration with a message naming it', async () => {
    __test.nuxtApp = { $lukk: { passkeyRegistrationOptions: vi.fn().mockResolvedValue({ challenge: 'c' }), registerPasskey: vi.fn() } }
    withNavigator(vi.fn().mockResolvedValue(null), vi.fn())

    await expect(useLukkPasskeys().register()).rejects.toThrow('lukk: the browser returned no passkey credential')
  })

  it('fails a sign-in with the same message, and sends nothing', async () => {
    const $lukk = { passkeyLoginOptions: vi.fn().mockResolvedValue({ ceremony_id: 'cer', options: { challenge: 'c' } }), loginWithPasskey: vi.fn() }
    __test.nuxtApp = { $lukk }
    withNavigator(vi.fn(), vi.fn().mockResolvedValue(null))

    await expect(useLukkPasskeys().login()).rejects.toThrow('lukk: the browser returned no passkey credential')
    expect(signInWith).not.toHaveBeenCalled()
  })
})

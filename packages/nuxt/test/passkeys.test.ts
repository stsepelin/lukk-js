import { afterEach, describe, expect, it, vi } from 'vitest'
import { __test, useState } from './mocks/imports'

// The serialization helpers are 100%-tested in lukk-core; here we test orchestration.
vi.mock('lukk-core', () => ({
  toCreationOptions: (json: unknown) => ({ creation: json }),
  toRequestOptions: (json: unknown) => ({ request: json }),
  credentialToJSON: (cred: { id: string }) => ({ serialized: cred.id }),
}))

const fetchUser = vi.fn()
vi.mock('../src/runtime/composables/useLukkAuth', () => ({ useLukkAuth: () => ({ fetchUser }) }))

// eslint-disable-next-line import/first
import { useLukkConfirmation } from '../src/runtime/composables/useLukkConfirmation'
// eslint-disable-next-line import/first
import { useLukkPasskeys } from '../src/runtime/composables/useLukkPasskeys'

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

  it('logs in with a passkey and loads the user', async () => {
    const $lukk = {
      passkeyLoginOptions: vi.fn().mockResolvedValue({ ceremony_id: 'cer', options: { challenge: 'c' } }),
      loginWithPasskey: vi.fn().mockResolvedValue({ access_token: 'a', expires_in: 900 }),
    }
    __test.nuxtApp = { $lukk }
    const get = vi.fn().mockResolvedValue({ id: 'cred-2' })
    withNavigator(vi.fn(), get)

    await useLukkPasskeys().login()

    expect(get).toHaveBeenCalledWith({ publicKey: { request: { challenge: 'c' } } })
    expect($lukk.loginWithPasskey).toHaveBeenCalledWith('cer', { serialized: 'cred-2' })
    expect(fetchUser).toHaveBeenCalledOnce()
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
    expect(useState<string | null>('lukk:confirmation', () => null).value).toBe('tok')
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

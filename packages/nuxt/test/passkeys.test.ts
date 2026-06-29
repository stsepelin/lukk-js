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
      passkeyLoginOptions: vi.fn().mockResolvedValue({ ceremony_id: 'cer', options: { challenge: 'c' } }),
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

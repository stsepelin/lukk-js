import { afterEach, describe, expect, it, vi } from 'vitest'
import { useLukkTwoFactor } from '../src/runtime/composables/useLukkTwoFactor'
import { __test } from './mocks/imports'

afterEach(() => __test.reset())

describe('useLukkTwoFactor', () => {
  it('delegates each management action to the client', async () => {
    const lukk = {
      enableTwoFactor: vi.fn().mockResolvedValue({ otpauth_uri: 'otpauth://x', recovery_codes: ['a'] }),
      confirmTwoFactor: vi.fn().mockResolvedValue(undefined),
      disableTwoFactor: vi.fn().mockResolvedValue(undefined),
      recoveryCodeCount: vi.fn().mockResolvedValue({ remaining: 3, total: 8 }),
      regenerateRecoveryCodes: vi.fn().mockResolvedValue({ recovery_codes: ['b'] }),
    }
    __test.nuxtApp = { $lukk: lukk }
    const tf = useLukkTwoFactor()

    expect(await tf.enable()).toMatchObject({ otpauth_uri: 'otpauth://x' })
    await tf.confirm('123456')
    expect(lukk.confirmTwoFactor).toHaveBeenCalledWith('123456')
    await tf.disable()
    expect(lukk.disableTwoFactor).toHaveBeenCalledOnce()
    expect(await tf.recoveryCodeCount()).toEqual({ remaining: 3, total: 8 })
    expect(await tf.regenerateRecoveryCodes()).toEqual({ recovery_codes: ['b'] })
  })

  it('passes lukk\'s 409s through as they came — confirming two-factor already on, codes without it', async () => {
    // Nothing to bind, so nothing changed: the caller gets the LukkError with its field, for a form to show.
    const already = { status: 409, message: 'Two-factor authentication is already enabled.', errors: { code: ['Two-factor authentication is already enabled.'] } }
    const without = { status: 409, message: 'Two-factor authentication is not enabled.', errors: { two_factor: ['Two-factor authentication is not enabled.'] } }
    __test.nuxtApp = { $lukk: { confirmTwoFactor: vi.fn().mockRejectedValue(already), regenerateRecoveryCodes: vi.fn().mockRejectedValue(without) } }
    const tf = useLukkTwoFactor()

    await expect(tf.confirm('123456')).rejects.toBe(already)
    await expect(tf.regenerateRecoveryCodes()).rejects.toBe(without)
  })
})

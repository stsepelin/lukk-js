import { afterEach, describe, expect, it, vi } from 'vitest'
import { useLukkConfirmation } from '../src/runtime/composables/useLukkConfirmation'
import { __test, useState } from './mocks/imports'

afterEach(() => __test.reset())

describe('useLukkConfirmation', () => {
  it('confirms with a password and stores the token for the client to attach', async () => {
    const lukkConfirm = vi.fn().mockResolvedValue({ confirmation_token: 'tok' })
    __test.nuxtApp = { $lukk: { confirmPassword: lukkConfirm } }
    const { confirmed, token, confirmPassword } = useLukkConfirmation()

    expect(confirmed.value).toBe(false)
    await confirmPassword('secret')

    expect(lukkConfirm).toHaveBeenCalledWith('secret')
    expect(token.value).toBe('tok')
    expect(confirmed.value).toBe(true)
    // the client's getConfirmationToken reads the same shared state → auto-attaches it
    expect(useState<string | null>('lukk:confirmation', () => null).value).toBe('tok')
  })

  it('marks confirmed without storing a token when the proxy strips it (BFF mode)', async () => {
    __test.nuxtApp = { $lukk: { confirmPassword: vi.fn().mockResolvedValue({ ok: true }) } }
    const { confirmed, token, confirmPassword } = useLukkConfirmation()

    await confirmPassword('secret')
    expect(confirmed.value).toBe(true)
    expect(token.value).toBeNull() // held server-side by the proxy
  })

  it('clear() drops the confirmation', async () => {
    __test.nuxtApp = { $lukk: { confirmPassword: vi.fn().mockResolvedValue({ confirmation_token: 'tok' }) } }
    const { confirmPassword, clear, confirmed } = useLukkConfirmation()

    await confirmPassword('secret')
    expect(confirmed.value).toBe(true)
    clear()
    expect(confirmed.value).toBe(false)
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { __test } from './mocks/imports'
import { useLukkPasswordReset } from '../src/runtime/composables/useLukkPasswordReset'

afterEach(() => { __test.reset(); vi.clearAllMocks() })

describe('useLukkPasswordReset', () => {
  it('requests a reset link and toggles `sending`', async () => {
    let release: () => void = () => {}
    const forgotPassword = vi.fn(() => new Promise<void>((r) => { release = r }))
    __test.nuxtApp = { $lukk: { forgotPassword } }
    const pr = useLukkPasswordReset()

    const pending = pr.sendResetLink('a@b.c')
    expect(pr.sending.value).toBe(true)
    release()
    await pending

    expect(pr.sending.value).toBe(false)
    expect(forgotPassword).toHaveBeenCalledWith('a@b.c')
  })

  it('clears `sending` even when the request rejects', async () => {
    const forgotPassword = vi.fn().mockRejectedValue(new Error('throttled'))
    __test.nuxtApp = { $lukk: { forgotPassword } }
    const pr = useLukkPasswordReset()

    await expect(pr.sendResetLink('a@b.c')).rejects.toThrow('throttled')
    expect(pr.sending.value).toBe(false)
  })

  it('completes a reset and toggles `resetting`', async () => {
    let release: () => void = () => {}
    const resetPassword = vi.fn(() => new Promise<void>((r) => { release = r }))
    __test.nuxtApp = { $lukk: { resetPassword } }
    const pr = useLukkPasswordReset()
    const input = { token: 't', email: 'a@b.c', password: 'new-secret-123', password_confirmation: 'new-secret-123' }

    const pending = pr.reset(input)
    expect(pr.resetting.value).toBe(true)
    release()
    await pending

    expect(pr.resetting.value).toBe(false)
    expect(resetPassword).toHaveBeenCalledWith(input)
  })

  it('clears `resetting` even when the reset rejects', async () => {
    const resetPassword = vi.fn().mockRejectedValue(new Error('invalid token'))
    __test.nuxtApp = { $lukk: { resetPassword } }
    const pr = useLukkPasswordReset()

    await expect(pr.reset({ token: 'bad', email: 'a@b.c', password: 'x', password_confirmation: 'x' })).rejects.toThrow('invalid token')
    expect(pr.resetting.value).toBe(false)
  })
})

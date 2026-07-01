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

const tick = () => new Promise(resolve => setTimeout(resolve))

describe('useLukkConfirmation withConfirmation (modal flow)', () => {
  it('runs the action directly when no confirmation is needed', async () => {
    const action = vi.fn(async () => 'ok')
    __test.nuxtApp = { $lukk: {} }
    const { withConfirmation, required } = useLukkConfirmation()

    expect(await withConfirmation(action)).toBe('ok')
    expect(action).toHaveBeenCalledOnce()
    expect(required.value).toBe(false)
  })

  it('opens the modal on 423, then retries once after a fresh confirmation', async () => {
    let attempts = 0
    const action = vi.fn(async () => {
      if (++attempts === 1) throw { status: 423 }
      return 'done'
    })
    __test.nuxtApp = { $lukk: { confirmPassword: vi.fn().mockResolvedValue({ confirmation_token: 't' }) } }
    const { withConfirmation, required, confirmPassword } = useLukkConfirmation()

    const pending = withConfirmation(action)
    await tick()
    expect(required.value).toBe(true) // the modal should be open

    await confirmPassword('secret') // the modal earns a fresh confirmation
    expect(await pending).toBe('done')
    expect(action).toHaveBeenCalledTimes(2)
    expect(required.value).toBe(false)
  })

  it('drops a stale confirmation on 423 before re-prompting', async () => {
    let attempts = 0
    const action = vi.fn(async () => {
      if (++attempts === 1) throw { status: 423 }
      return 'ok'
    })
    __test.nuxtApp = { $lukk: { confirmPassword: vi.fn().mockResolvedValue({ confirmation_token: 't' }) } }
    const c = useLukkConfirmation()
    c.record({ confirmation_token: 'stale' }) // client thinks it's confirmed…
    expect(c.confirmed.value).toBe(true)

    const pending = c.withConfirmation(action)
    await tick()
    expect(c.confirmed.value).toBe(false) // …but the 423 cleared it, so the modal is required
    expect(c.required.value).toBe(true)

    await c.confirmPassword('secret')
    expect(await pending).toBe('ok')
  })

  it('rethrows a non-423 error without opening the modal', async () => {
    const action = vi.fn(async () => { throw { status: 500 } })
    __test.nuxtApp = { $lukk: {} }
    const { withConfirmation, required } = useLukkConfirmation()

    await expect(withConfirmation(action)).rejects.toMatchObject({ status: 500 })
    expect(required.value).toBe(false)
    expect(action).toHaveBeenCalledOnce()
  })

  it('cancel() aborts a pending confirmation (no retry)', async () => {
    const action = vi.fn(async () => { throw { status: 423 } })
    __test.nuxtApp = { $lukk: {} }
    const { withConfirmation, required, cancel } = useLukkConfirmation()

    const pending = withConfirmation(action)
    await tick()
    expect(required.value).toBe(true)

    cancel()
    await expect(pending).rejects.toThrow('cancelled')
    expect(required.value).toBe(false)
    expect(action).toHaveBeenCalledOnce()
  })
})

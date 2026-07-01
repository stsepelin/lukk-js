import { ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { __test } from './mocks/imports'

const user = ref<unknown>(null)
const fetchUser = vi.fn()
vi.mock('../src/runtime/composables/useLukkAuth', () => ({ useLukkAuth: () => ({ user, fetchUser }) }))

// eslint-disable-next-line import/first
import { useLukkEmailVerification } from '../src/runtime/composables/useLukkEmailVerification'

afterEach(() => { __test.reset(); user.value = null; vi.clearAllMocks() })

describe('useLukkEmailVerification', () => {
  it('reports `verified` from the loaded user', () => {
    __test.nuxtApp = { $lukk: {} }
    const ev = useLukkEmailVerification()

    expect(ev.verified.value).toBe(false) // no user
    user.value = { email_verified_at: '2026-07-01T00:00:00Z' }
    expect(ev.verified.value).toBe(true)
    user.value = { email_verified_at: null }
    expect(ev.verified.value).toBe(false)
  })

  it('resends the verification email and toggles `sending`', async () => {
    let release: () => void = () => {}
    const sendEmailVerification = vi.fn(() => new Promise<void>((r) => { release = r }))
    __test.nuxtApp = { $lukk: { sendEmailVerification } }
    const ev = useLukkEmailVerification()

    const pending = ev.sendVerificationEmail()
    expect(ev.sending.value).toBe(true)
    release()
    await pending

    expect(ev.sending.value).toBe(false)
    expect(sendEmailVerification).toHaveBeenCalledOnce()
  })

  it('clears `sending` even when the resend rejects', async () => {
    const sendEmailVerification = vi.fn().mockRejectedValue(new Error('throttled'))
    __test.nuxtApp = { $lukk: { sendEmailVerification } }
    const ev = useLukkEmailVerification()

    await expect(ev.sendVerificationEmail()).rejects.toThrow('throttled')
    expect(ev.sending.value).toBe(false)
  })

  it('`syncAfterVerify` reloads the user', async () => {
    __test.nuxtApp = { $lukk: {} }
    const ev = useLukkEmailVerification()

    await ev.syncAfterVerify()
    expect(fetchUser).toHaveBeenCalledOnce()
  })
})

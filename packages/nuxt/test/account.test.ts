import { ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { __test } from './mocks/imports'

const user = ref<unknown>({ id: 1 })
// Mirrors the real `logout()` in both halves: it clears local state in a `finally` and then
// RE-THROWS, because the erasure just denylisted this token so the call always 401s. Asserting on a
// bare `vi.fn()` proved the call happened, never that the state changed — so anything that stopped
// `logout()` clearing `user` would have left this suite green.
const logout = vi.fn(async () => {
  try { throw { status: 401 } }
  finally { user.value = null }
})
vi.mock('../src/runtime/composables/useLukkAuth', () => ({ useLukkAuth: () => ({ user, logout }) }))

const withConfirmation = vi.fn(<T>(action: () => Promise<T>) => action())
vi.mock('../src/runtime/composables/useLukkConfirmation', () => ({ useLukkConfirmation: () => ({ withConfirmation }) }))

// eslint-disable-next-line import/first
import { useLukkAccount } from '../src/runtime/composables/useLukkAccount'

afterEach(() => { __test.reset(); user.value = { id: 1 }; vi.clearAllMocks() })

describe('useLukkAccount', () => {
  it('erases the account through step-up and clears local auth state', () => {
    // The server has already revoked every token by the time this resolves, so there is nothing to
    // log out OF — but `user` would otherwise sit there describing an account that no longer exists,
    // and route middleware would keep treating the visitor as signed in.
    const deleteAccount = vi.fn().mockResolvedValue(undefined)
    __test.nuxtApp = { $lukk: { deleteAccount } }
    const account = useLukkAccount()

    const pending = account.deleteAccount()
    expect(account.busy.value).toBe(true)

    return pending.then(() => {
      expect(withConfirmation).toHaveBeenCalledOnce()
      expect(deleteAccount).toHaveBeenCalledOnce()
      expect(logout).toHaveBeenCalledOnce()
      expect(user.value).toBeNull() // the EFFECT, not just the call
      expect(account.busy.value).toBe(false)
    })
  })

  it('does not clear local state when the erasure failed', async () => {
    // A refused or failed erasure must not look like a successful one: the account still exists and
    // the session is still valid.
    __test.nuxtApp = { $lukk: { deleteAccount: vi.fn().mockRejectedValue({ status: 423 }) } }
    const account = useLukkAccount()

    await expect(account.deleteAccount()).rejects.toMatchObject({ status: 423 })

    expect(logout).not.toHaveBeenCalled()
    expect(user.value).not.toBeNull() // a refused erasure must not look like a successful one
    expect(account.busy.value).toBe(false)
  })

  it('returns the export and clears busy even when it throws', async () => {
    const exportAccount = vi.fn().mockResolvedValue({ generated_at: 'now', sessions: [] })
    __test.nuxtApp = { $lukk: { exportAccount } }
    const account = useLukkAccount()

    await expect(account.exportAccount()).resolves.toMatchObject({ generated_at: 'now' })
    expect(account.busy.value).toBe(false)

    __test.nuxtApp = { $lukk: { exportAccount: vi.fn().mockRejectedValue(new Error('boom')) } }
    const failing = useLukkAccount()
    await expect(failing.exportAccount()).rejects.toThrow('boom')
    expect(failing.busy.value).toBe(false)
  })
})

describe('a successful erasure whose logout call fails', () => {
  it('still resolves — the account is gone, and the caller must not be told otherwise', async () => {
    // The erasure denylisted this token, so `POST /auth/logout` answers 401 every time. `logout()`
    // clears local state and re-throws, so without a `.catch()` every completed, irreversible
    // erasure rejected and every consumer showed "erasure failed".
    __test.nuxtApp = { $lukk: { deleteAccount: vi.fn().mockResolvedValue(undefined) } }
    const account = useLukkAccount()

    await expect(account.deleteAccount()).resolves.toBeUndefined()

    expect(logout).toHaveBeenCalledOnce()
    expect(user.value).toBeNull()
    expect(account.busy.value).toBe(false)
  })
})

describe('useLukkAccount busy tracking', () => {
  it('stays busy until the LAST overlapping call settles', async () => {
    // `busy` was a boolean each call cleared independently, so the first to finish re-enabled the
    // bound control while the other was still in flight — permitting a duplicate export, or a second
    // erasure attempt. Overlap is the normal shape here rather than an edge case: `withConfirmation`
    // parks on a modal waiting for the user, so a call can sit pending indefinitely.
    let releaseFirst: (v: unknown) => void = () => {}
    const first = new Promise(resolve => (releaseFirst = resolve))
    let releaseSecond: (v: unknown) => void = () => {}
    const second = new Promise(resolve => (releaseSecond = resolve))

    const exportAccount = vi.fn()
      .mockImplementationOnce(() => first)
      .mockImplementationOnce(() => second)
    __test.nuxtApp = { $lukk: { exportAccount } }
    const account = useLukkAccount()

    const a = account.exportAccount()
    const b = account.exportAccount()
    expect(account.busy.value).toBe(true)

    releaseFirst({ generated_at: 'x' })
    await a
    // The second is STILL running — the whole point.
    expect(account.busy.value).toBe(true)

    releaseSecond({ generated_at: 'y' })
    await b
    expect(account.busy.value).toBe(false)
  })

  it('releases the count when a call rejects', async () => {
    // A throwing export must not strand `busy` at true forever, disabling the control for good.
    const exportAccount = vi.fn().mockRejectedValue(new Error('nope'))
    __test.nuxtApp = { $lukk: { exportAccount } }
    const account = useLukkAccount()

    await expect(account.exportAccount()).rejects.toThrow('nope')
    expect(account.busy.value).toBe(false)
  })
})

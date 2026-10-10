import { afterEach, describe, expect, it, vi } from 'vitest'
import { useLukkConfirmation } from '../src/runtime/composables/useLukkConfirmation'
import { __test } from './mocks/imports'
import { useLukkSecret } from '../src/runtime/utils/secrets'

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
    expect(useLukkSecret('confirmation').value).toBe('tok')
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

describe('a step-up this token can never earn', () => {
  it('abandons the pending confirmation on a 403 instead of hanging', async () => {
    // A pinned machine token without `lukk.account` is refused by the step-up route itself. Without
    // this, `withConfirmation` sets `required` and waits for `confirmed` — which can never flip — so
    // the promise never settles, the modal stays open, and every retry burns the shared throttle.
    __test.nuxtApp = { $lukk: { confirmPassword: vi.fn().mockRejectedValue({ status: 403 }) } }
    const { required, confirmed, confirmPassword } = useLukkConfirmation()

    required.value = true

    await expect(confirmPassword('secret')).rejects.toMatchObject({ status: 403 })

    expect(required.value).toBe(false) // → confirmedOrCancelled rejects, the caller sees a real error
    expect(confirmed.value).toBe(false)
  })

  it('leaves a pending confirmation alone for a wrong password', async () => {
    // 422 is retryable — the user can try again, so the modal must stay open.
    __test.nuxtApp = { $lukk: { confirmPassword: vi.fn().mockRejectedValue({ status: 422 }) } }
    const { required, confirmPassword } = useLukkConfirmation()

    required.value = true

    await expect(confirmPassword('wrong')).rejects.toMatchObject({ status: 422 })

    expect(required.value).toBe(true)
  })
})

describe('an unearnable step-up reported to the caller', () => {
  it('rejects with the real 403, not a synthetic "cancelled"', async () => {
    // `abandonIfUnearnable` drops `required`, which makes `confirmedOrCancelled` reject. Rejecting
    // with a synthetic Error told the caller the user dismissed a modal they never saw, and threw
    // away the 403 that explains it — the expected outcome for a machine token holding
    // `lukk.account` but not `lukk.account.delete`.
    __test.nuxtApp = {
      $lukk: {
        confirmPassword: vi.fn().mockRejectedValue({ status: 403, message: 'This token was issued with a fixed set of abilities' }),
      },
    }
    const { required, confirmPassword, withConfirmation } = useLukkConfirmation()

    const gated = withConfirmation(() => Promise.reject({ status: 423 }))
    await Promise.resolve()
    expect(required.value).toBe(true)

    await expect(confirmPassword('secret')).rejects.toMatchObject({ status: 403 })
    await expect(gated).rejects.toMatchObject({ status: 403 })
  })
})

describe('a 423 answering a request sent before the current confirmation', () => {
  it('retries once with the confirmation that landed meanwhile, instead of clearing it and asking again', async () => {
    // Two gated actions out at once: the first's 423 opens the modal, the user confirms, and THEN the
    // second's 423 — sent before that confirmation existed — arrives. Clearing on it wiped the confirmation
    // just earned and reopened the modal.
    __test.nuxtApp = { $lukk: { confirmPassword: vi.fn().mockResolvedValue({ confirmation_token: 'fresh' }) } }
    const { confirmPassword, withConfirmation, required, confirmed } = useLukkConfirmation()
    let reject423!: () => void
    const second = vi.fn()
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { reject423 = () => reject({ status: 423 }) }))
      .mockResolvedValueOnce('done')

    const pending = withConfirmation(second)
    await confirmPassword('secret') // landed while the second was out
    reject423()

    await expect(pending).resolves.toBe('done')
    expect(second).toHaveBeenCalledTimes(2)
    expect(required.value).toBe(false)
    expect(confirmed.value).toBe(true)
  })
})

describe('the unearnable error is the app\'s, not one composable instance\'s', () => {
  it('reaches the action waiting in ANOTHER instance — the page wraps, the modal confirms', async () => {
    // The documented shape: a page calls `withConfirmation()` from its own `useLukkConfirmation()`, and the
    // modal bound to `required` calls `confirmPassword()` from ITS own. Held per instance, the 403 landed
    // in the modal's copy, and the page's action rejected as "cancelled" — the misreport this exists to stop.
    const refused = { status: 403, message: 'This token was issued with a fixed set of abilities' }
    __test.nuxtApp = { $lukk: { confirmPassword: vi.fn().mockRejectedValue(refused) } }
    const page = useLukkConfirmation()
    const modal = useLukkConfirmation()

    const gated = page.withConfirmation(() => Promise.reject({ status: 423 }))
    await Promise.resolve()
    expect(modal.required.value).toBe(true)

    await expect(modal.confirmPassword('secret')).rejects.toBe(refused)
    // The very error, not a copy or a reactive proxy of it.
    await expect(gated).rejects.toBe(refused)
  })

  it('never carries over to another app — on the server, another request', async () => {
    __test.nuxtApp = { $lukk: { confirmPassword: vi.fn().mockRejectedValue({ status: 403 }) } }
    useLukkConfirmation().abandonIfUnearnable({ status: 403 })

    __test.nuxtApp = { $lukk: {} }
    const next = useLukkConfirmation()
    const waiting = next.withConfirmation(() => Promise.reject({ status: 423 }))
    await Promise.resolve()
    next.cancel()

    await expect(waiting).rejects.toThrow('lukk: confirmation cancelled')
  })
})

describe('the unearnable error does not outlive its cycle', () => {
  it('reports a later CANCELLATION as cancelled, not as the earlier 403', async () => {
    // `unearnable` was only ever set, never cleared. Once any action hit a 403, every later
    // cancellation on the same composable instance rejected with that stale 403 — telling the user
    // "this token can never earn a step-up" about an operation they simply dismissed, and telling
    // the developer to go looking for an abilities problem that isn't there.
    __test.nuxtApp = {
      $lukk: { confirmPassword: vi.fn().mockRejectedValue({ status: 403, message: 'fixed abilities' }) },
    }
    const { required, confirmPassword, withConfirmation, cancel } = useLukkConfirmation()

    // Cycle 1: a genuine unearnable 403.
    const first = withConfirmation(() => Promise.reject({ status: 423 }))
    await Promise.resolve()
    await expect(confirmPassword('secret')).rejects.toMatchObject({ status: 403 })
    await expect(first).rejects.toMatchObject({ status: 403 })

    // Cycle 2: the user just closes the modal.
    const second = withConfirmation(() => Promise.reject({ status: 423 }))
    await Promise.resolve()
    expect(required.value).toBe(true)
    cancel()

    await expect(second).rejects.toThrow('lukk: confirmation cancelled')
  })
})

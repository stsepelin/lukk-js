import { afterEach, describe, expect, it, vi } from 'vitest'
import { useState } from '#imports'
import { __test } from './mocks/imports'
import { useLukkPassword } from '../src/runtime/composables/useLukkPassword'

afterEach(() => { __test.reset(); vi.clearAllMocks() })

const input = {
  current_password: 'old-secret',
  password: 'new-secret',
  password_confirmation: 'new-secret',
}

describe('useLukkPassword', () => {
  it('sends the change and toggles `changing` across the request', async () => {
    let release: () => void = () => {}
    const changePassword = vi.fn(() => new Promise<void>((r) => { release = r }))
    __test.nuxtApp = { $lukk: { changePassword } }
    const pw = useLukkPassword()

    const pending = pw.changePassword(input)
    expect(pw.changing.value).toBe(true)
    release()
    await pending

    expect(pw.changing.value).toBe(false)
    expect(changePassword).toHaveBeenCalledWith(input)
  })

  it('clears `changing` even when the request rejects', async () => {
    // A wrong current password is a 422, and the endpoint shares the step-up throttle, so 429 and
    // 423 are both reachable. None of them may leave a submit button disabled forever.
    const changePassword = vi.fn().mockRejectedValue({ status: 422, message: 'The provided password is incorrect.' })
    __test.nuxtApp = { $lukk: { changePassword } }
    const pw = useLukkPassword()

    await expect(pw.changePassword(input)).rejects.toMatchObject({ status: 422 })
    expect(pw.changing.value).toBe(false)
  })

  it('does not touch session state — the current session survives the change', async () => {
    // lukk revokes every OTHER session and keeps this one, so there is no token to swap and
    // nothing to re-login. A composable that cleared state here would log the user out of the tab
    // they just changed their password in.
    const changePassword = vi.fn().mockResolvedValue(undefined)
    __test.nuxtApp = { $lukk: { changePassword } }
    const access = useState<string | null>('lukk:access', () => 'live-token')

    await useLukkPassword().changePassword(input)

    expect(access.value).toBe('live-token')
    expect(changePassword).toHaveBeenCalledOnce()
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { CONFIRMED_KEY } from '../../src/runtime/keys'
import { __test, useState } from '../mocks/imports'

import { useLukkConfirmation } from '../../src/runtime/composables/useLukkConfirmation'
import { useLukkSecret } from '../../src/runtime/utils/secrets'

vi.mock('../../src/runtime/composables/useLukkFetch', () => ({ useLukkFetch: () => vi.fn() }))

afterEach(() => { __test.reset(); vi.restoreAllMocks() })

describe('useLukkConfirmation on the server', () => {
  it('records nothing — a step-up is earned by a request the browser made', async () => {
    // Both halves are `useState`, so either one written here serialises into `__NUXT_DATA__` and claims a
    // step-up for whoever the render is handed to.
    __test.nuxtApp = { $lukk: { confirmPassword: vi.fn().mockResolvedValue({ confirmation_token: 'stepped-up' }) } }
    const { confirmPassword, confirmed } = useLukkConfirmation()

    await confirmPassword('secret')

    expect(confirmed.value).toBe(false)
    expect(useLukkSecret('confirmation').value).toBeNull()
    expect(useState<boolean>(CONFIRMED_KEY, () => false).value).toBe(false)
  })
})

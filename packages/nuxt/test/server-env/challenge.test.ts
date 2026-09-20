import { afterEach, describe, expect, it, vi } from 'vitest'
import { CHALLENGE_KEY } from '../../src/runtime/keys'
import { __test, ssrPayload, useState } from '../mocks/imports'

vi.mock('../../src/runtime/composables/useLukkFetch', () => ({ useLukkFetch: () => vi.fn() }))

// eslint-disable-next-line import/first
import { useLukkAuth } from '../../src/runtime/composables/useLukkAuth'

afterEach(() => { __test.reset(); vi.restoreAllMocks() })

describe('a two-factor challenge answered during a server render', () => {
  // The challenge token is a live, single-use credential, and no session cookie exists yet at this point —
  // so `no-store` never fires. Written to `useState` here, it would serialise into `__NUXT_DATA__` and a
  // CDN could cache the page with it embedded.
  it.each(['login', 'register'] as const)('%s hands the challenge back but never puts it in the payload', async (method) => {
    const answer = { two_factor: true, challenge_token: 'live-challenge' }
    __test.nuxtApp = { $lukk: { [method]: vi.fn().mockResolvedValue(answer) } }
    const auth = useLukkAuth()

    const result = await (auth[method] as (input: unknown) => Promise<unknown>)({ email: 'e', password: 'p' })

    expect(result).toEqual(answer)
    expect(useState<string | null>(CHALLENGE_KEY, () => null).value).toBeNull()
    expect(JSON.stringify(ssrPayload())).not.toContain('live-challenge')
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { __test } from '../mocks/imports'

vi.mock('../../src/runtime/composables/useLukkFetch', () => ({ useLukkFetch: () => vi.fn() }))

// eslint-disable-next-line import/first
import { useLukkAuth } from '../../src/runtime/composables/useLukkAuth'

afterEach(() => { __test.reset(); vi.restoreAllMocks() })

describe('useLukkAuth on the server', () => {
  it('whenReady() resolves at once even though the session is unresolved', async () => {
    // Nothing later in a server request can resolve the session — waiting would hang the render.
    __test.nuxtApp = { $lukk: {} }
    __test.runtimeConfig.public.lukk = { mode: 'bff', baseURL: '', confirmationHeader: 'X', userEndpoint: '/me', userKey: '' }
    const { ready, whenReady } = useLukkAuth()

    const outcome = await Promise.race([
      whenReady().then(() => 'resolved'),
      new Promise(resolve => setTimeout(() => resolve('HUNG'), 50)),
    ])

    expect(outcome).toBe('resolved')
    // …and it did not pretend the session was resolved: the caller must still read `ready`.
    expect(ready.value).toBe(false)
  })

  it('does not warn about a premature wait on the server', async () => {
    // The warning is about client plugins deadlocking on the restore; the server has no restore plugin.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    __test.nuxtApp = { $lukk: {} }
    __test.runtimeConfig.public.lukk = { mode: 'bff', baseURL: '', confirmationHeader: 'X', userEndpoint: '/me', userKey: '' }

    await useLukkAuth().whenReady()

    expect(warn).not.toHaveBeenCalled()
  })
})

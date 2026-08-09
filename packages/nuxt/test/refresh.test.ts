import { afterEach, describe, expect, it, vi } from 'vitest'
import { refreshOnce } from '../src/runtime/server/utils/refresh'

afterEach(() => vi.restoreAllMocks())

describe('refreshOnce with an unusable baseURL', () => {
  it('returns null (not refreshable) instead of fetching a null target', async () => {
    // The module rejects such a baseURL at build, so this is only reachable via a runtime override
    // (NUXT_LUKK_BASE_URL). It must fail as "not refreshable" — never as an unreadable fetch throw,
    // and never by hitting the network with an unresolved target.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('fetch must not be called with an unresolved target')
    })

    const result = await refreshOnce({ id: 'sid', data: { refresh: 'rt' } }, 'undefined/auth')

    expect(result).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(String(error.mock.calls[0]![0])).toContain('undefined/auth')
  })
})

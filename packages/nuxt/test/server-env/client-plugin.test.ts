import { afterEach, describe, expect, it, vi } from 'vitest'
import { ACCESS_KEY, USER_KEY } from '../../src/runtime/keys'
import { __test, ssrPayload, useState } from '../mocks/imports'

const wire = vi.hoisted(() => ({ hooks: undefined as { onTokens: (pair: unknown) => void } | undefined }))
vi.mock('lukk-core', async importActual => ({
  ...(await importActual<typeof import('lukk-core')>()),
  createLukkClient: vi.fn((hooks: { onTokens: (pair: unknown) => void }) => {
    wire.hooks = hooks
    return { refreshTokens: vi.fn(async () => ({ access_token: 'minted-on-the-server', expires_in: 900 })) }
  }),
}))
const { api } = vi.hoisted(() => ({ api: vi.fn() }))
vi.mock('../../src/runtime/composables/useLukkFetch', () => ({ useLukkFetch: () => api }))

// eslint-disable-next-line import/first
import clientPlugin from '../../src/runtime/plugins/client'

afterEach(() => { __test.reset(); api.mockReset() })

describe('the client plugin during a server render', () => {
  it('never puts an access token in the payload — not from onTokens, not from a refresh', async () => {
    // `useState` written here serialises into `__NUXT_DATA__`, and the page may be cached for anyone.
    __test.runtimeConfig.public.lukk = { mode: 'direct', baseURL: 'https://api/auth', confirmationHeader: 'X-Lukk-Confirmation', userEndpoint: 'https://app/me', userKey: '' }
    const { provide } = (clientPlugin as unknown as () => { provide: { lukkRefresh: () => Promise<unknown> } })()
    // A user with abilities is re-synced after every refresh in the browser; never from the server.
    useState(USER_KEY, () => null).value = { id: 1, abilities: [] }

    wire.hooks!.onTokens({ access_token: 'minted-on-the-server', expires_in: 900 })
    await provide.lukkRefresh()

    expect(useState<string | null>(ACCESS_KEY, () => null).value).toBeNull()
    expect(JSON.stringify(ssrPayload())).not.toContain('minted-on-the-server')
    // Nor does it reload the user from the server on a refresh — that is the browser's to do.
    expect(api).not.toHaveBeenCalled()
  })
})

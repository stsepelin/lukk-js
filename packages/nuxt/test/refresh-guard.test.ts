import { afterEach, describe, expect, it, vi } from 'vitest'
import { __test } from './mocks/imports'

// Stub only lukk-core's client factory (as plugins.test.ts does) — the plugin MODULES and the real
// `useLukkAuth` run unmocked, so this exercises the actual hydration path, not a stand-in.
const captured: { client?: { refreshTokens: ReturnType<typeof vi.fn> } } = {}
vi.mock('lukk-core', async importActual => ({
  ...(await importActual<typeof import('lukk-core')>()),
  createLukkClient: vi.fn(() => {
    // No session → refresh rejects → the shared `safeRefresh` resolves null (logged-out).
    captured.client = { refreshTokens: vi.fn().mockRejectedValue(new Error('no session')) }
    return captured.client
  }),
}))

// eslint-disable-next-line import/first
import clientPlugin from '../src/runtime/plugins/client'
// eslint-disable-next-line import/first
import sessionPlugin from '../src/runtime/plugins/session.client'
// eslint-disable-next-line import/first
import { useLukkAuth } from '../src/runtime/composables/useLukkAuth'

const run = (p: unknown) => (p as () => unknown)()
const bffConfig = { mode: 'bff', baseURL: '', confirmationHeader: 'X', apiBaseURL: '/api/_lukk', userEndpoint: '' }

afterEach(() => { __test.reset(); captured.client = undefined; vi.clearAllMocks() })

describe('$lukkRefresh guard (real client + session-restore plugins)', () => {
  it('degrades to logged-out (never throws) when the client plugin provide is missing', async () => {
    __test.runtimeConfig.public.lukk = { ...bffConfig }
    // `$lukkRefresh` is absent — simulate the client plugin's provide not being in effect on hydration.
    await expect(run(sessionPlugin) as Promise<void>).resolves.toBeUndefined()
    expect(useLukkAuth().loggedIn.value).toBe(false)
  })

  it('restores nothing (logged-out) when the shared refresh yields null', async () => {
    __test.runtimeConfig.public.lukk = { ...bffConfig }
    // Run the real client plugin, then wire its provide onto the app — as Nuxt's `dependsOn` guarantees
    // before the session-restore plugin runs.
    const { provide } = run(clientPlugin) as { provide: { lukk: unknown, lukkRefresh: () => Promise<unknown> } }
    Object.assign(__test.nuxtApp, { $lukk: provide.lukk, $lukkRefresh: provide.lukkRefresh })

    await expect(run(sessionPlugin) as Promise<void>).resolves.toBeUndefined()
    expect(captured.client!.refreshTokens).toHaveBeenCalledTimes(1)
    expect(useLukkAuth().loggedIn.value).toBe(false)
  })
})

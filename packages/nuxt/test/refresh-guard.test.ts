import { afterEach, describe, expect, it, vi } from 'vitest'
import { __test } from './mocks/imports'

// Stub only lukk-core's client factory (as plugins.test.ts does) — the plugin MODULES and the real
// `useLukkAuth` run unmocked, so this exercises the actual hydration path, not a stand-in.
const captured: { client?: { refreshTokens: ReturnType<typeof vi.fn> } } = {}
vi.mock('lukk-core', async importActual => ({
  ...(await importActual<typeof import('lukk-core')>()),
  createLukkClient: vi.fn(() => {
    // No session → the BFF answers /refresh with a 401, which is what a real rejection carries. A bare
    // `new Error` has no status, and that is how an UNREACHABLE server looks — not an anonymous one.
    captured.client = { refreshTokens: vi.fn().mockRejectedValue({ status: 401, message: 'Unauthenticated.' }) }
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

describe('session restore with the real client + session-restore plugins', () => {
  it('degrades to logged-out (never throws) when the client plugin provide is missing', async () => {
    __test.runtimeConfig.public.lukk = { ...bffConfig }
    // `$lukkRefresh` is absent — simulate the client plugin's provide not being in effect on hydration.
    await expect(run(sessionPlugin) as Promise<void>).resolves.toBeUndefined()
    expect(useLukkAuth().loggedIn.value).toBe(false)
  })

  /** Run the real client plugin and inject EVERY provide as Nuxt does (`$` + key), so a provide added
   *  later cannot silently fall out of this harness — which is how `$lukkRestore` first went missing. */
  function provideClient(): void {
    __test.runtimeConfig.public.lukk = { ...bffConfig }
    const { provide } = run(clientPlugin) as { provide: Record<string, unknown> }
    Object.assign(__test.nuxtApp, Object.fromEntries(Object.entries(provide).map(([k, v]) => [`$${k}`, v])))
  }

  it('restores nothing (signed out, not failed) when there is no session', async () => {
    provideClient()

    await expect(run(sessionPlugin) as Promise<void>).resolves.toBeUndefined()
    expect(captured.client!.refreshTokens).toHaveBeenCalledTimes(1)
    expect(useLukkAuth().loggedIn.value).toBe(false)
    expect(useLukkAuth().restoreFailed.value).toBe(false)
    expect(useLukkAuth().ready.value).toBe(true)
  })

  it('reports a failed restore when the server cannot be reached', async () => {
    // A network failure rejects with no status at all. The visitor may be signed in, so this must
    // not read as "anonymous" — the end-to-end path the unit tests only cover piecewise.
    provideClient()
    captured.client!.refreshTokens.mockRejectedValueOnce(new TypeError('Failed to fetch'))

    await run(sessionPlugin)

    expect(useLukkAuth().loggedIn.value).toBe(false)
    expect(useLukkAuth().restoreFailed.value).toBe(true)
    expect(useLukkAuth().ready.value).toBe(true)
  })
})

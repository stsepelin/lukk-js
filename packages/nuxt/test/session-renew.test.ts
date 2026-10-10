import { afterEach, describe, expect, it, vi } from 'vitest'
import { __test } from './mocks/imports'

import renewPlugin from '../src/runtime/plugins/session-renew.server'

const resolveHydrationAccess = vi.fn()
const withholdIfReplaced = vi.fn()
const fetchUser = vi.fn()

vi.mock('../src/runtime/composables/useLukkAuth', () => ({ useLukkAuth: () => ({ fetchUser }) }))
vi.mock('../src/runtime/server/hydrate', () => ({
  resolveHydrationAccess: (...a: unknown[]) => resolveHydrationAccess(...a),
  withholdIfReplaced: (...a: unknown[]) => withholdIfReplaced(...a),
}))

const run = (nuxtApp: unknown) => (renewPlugin as unknown as (app: unknown) => Promise<void>)(nuxtApp)

function app(o: { serverRendered?: boolean, prerenderedAt?: unknown, ssrContext?: unknown } = {}) {
  const hooks: Record<string, (() => unknown)[]> = {}
  return {
    payload: { serverRendered: o.serverRendered ?? true, prerenderedAt: o.prerenderedAt },
    ssrContext: 'ssrContext' in o ? o.ssrContext : { event: {} },
    hooks: { hook: (name: string, fn: () => unknown) => { (hooks[name] ??= []).push(fn) } },
    call: (name: string) => hooks[name]?.forEach(fn => fn()),
  }
}

afterEach(() => { __test.reset(); vi.clearAllMocks() })

describe('session-renew.server (BFF, ssrHydrate: false)', () => {
  // With hydration off, a render's own app-API requests are marked and never renew the session (their
  // cookie would go back to the render, not the page). Without this step, every page rendered after the
  // access token aged out answered its SSR `useFetch` calls 401 — and Nuxt does not re-fetch an SSR error
  // on hydration, so the page showed it.
  it('renews an aged-out session before the render, without loading the user', async () => {
    resolveHydrationAccess.mockResolvedValue('fresh-access')
    const nuxtApp = app()

    await run(nuxtApp)

    expect(resolveHydrationAccess).toHaveBeenCalledWith(nuxtApp.ssrContext.event)
    expect(fetchUser).not.toHaveBeenCalled()
  })

  it('delivers the renewed cookie with the page: the last check runs once it rendered, or errored', async () => {
    resolveHydrationAccess.mockResolvedValue('fresh-access')
    const nuxtApp = app()

    await run(nuxtApp)
    expect(withholdIfReplaced).not.toHaveBeenCalled()
    nuxtApp.call('app:rendered')
    expect(withholdIfReplaced).toHaveBeenCalledTimes(1)
    nuxtApp.call('app:error')
    expect(withholdIfReplaced).toHaveBeenCalledTimes(2)
    expect(withholdIfReplaced).toHaveBeenCalledWith(nuxtApp.ssrContext.event)
  })

  it('leaves an anonymous or unrefreshable render alone', async () => {
    resolveHydrationAccess.mockResolvedValue(null)
    const nuxtApp = app()

    await run(nuxtApp)
    nuxtApp.call('app:rendered')

    expect(withholdIfReplaced).not.toHaveBeenCalled()
  })

  it.each([
    ['a client-side navigation', { serverRendered: false }],
    ['a prerendered page', { prerenderedAt: Date.now() }],
    ['a render without an event', { ssrContext: {} }],
    ['an app without an SSR context', { ssrContext: undefined }],
  ])('skips %s', async (_, o) => {
    await run(app(o))
    expect(resolveHydrationAccess).not.toHaveBeenCalled()
  })

  it('runs under its own name (after the render marker, which is `enforce: \'pre\'`)', () => {
    expect((renewPlugin as unknown as { meta: unknown }).meta).toEqual({ name: 'lukk:session-renew' })
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { __test } from './mocks/imports'

const sealed = vi.hoisted(() => ({ data: {} as { access?: string, refresh?: string } }))
vi.mock('../src/runtime/server/sealed-session', () => ({ readSealedSession: vi.fn(async () => sealed.data) }))

// eslint-disable-next-line import/first
import plugin from '../src/runtime/server/plugins/streaming-render'
// eslint-disable-next-line import/first
import { readSealedSession } from '../src/runtime/server/sealed-session'
// eslint-disable-next-line import/first
import { sessionCookieName } from '../src/runtime/shared'

type Context = { canStream?: boolean, prefersStream?: boolean }
type Hook = (context: Context, meta: { event: unknown }) => Promise<void>

const jwt = (exp: number) => `h.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.s`
const expired = () => jwt(Math.floor(Date.now() / 1000) - 60)
const fresh = () => jwt(Math.floor(Date.now() / 1000) + 3600)

function renderRoute(): Hook {
  const hooks: Record<string, Hook> = {}
  ;(plugin as unknown as (app: unknown) => void)({ hooks: { hook: (name: string, fn: Hook) => { hooks[name] = fn } } })
  __test.runtimeConfig.lukk = { sessionPassword: 'p'.repeat(32), cookieSecure: true } as unknown as Record<string, unknown>
  return hooks['render:route']!
}

afterEach(() => { __test.reset(); sealed.data = {}; vi.clearAllMocks() })

describe('streaming-render plugin', () => {
  it('opts a page out of streaming when its session must be refreshed during the render', async () => {
    // Its re-sealed cookie could not be withheld once streaming had sent the headers.
    sealed.data = { access: expired(), refresh: 'r' }
    const context = { canStream: true, prefersStream: true }

    await renderRoute()(context, { event: {} })

    expect(context.prefersStream).toBe(false)
  })

  it.each([
    ['a still-valid token', () => ({ access: fresh(), refresh: 'r' })],
    ['an expired token with nothing to refresh it', () => ({ access: expired() })],
    ['no session', () => ({})],
  ])('lets a page stream with %s', async (_, data) => {
    sealed.data = data()
    const context = { canStream: true, prefersStream: true }

    await renderRoute()(context, { event: {} })

    expect(context.prefersStream).toBe(true)
  })

  it('reads the session from the cookie the app actually sets', async () => {
    // With `cookieSecure: false` (local http) the cookie drops its `__Host-` prefix. Reading the prefixed
    // name there finds nothing, so an expired session streamed and its re-seal could not be withheld.
    const hook = renderRoute()
    __test.runtimeConfig.lukk = { sessionPassword: 'p'.repeat(32), cookieSecure: false } as unknown as Record<string, unknown>

    await hook({ canStream: true, prefersStream: true }, { event: {} })

    expect(vi.mocked(readSealedSession).mock.calls[0]![2]).toBe(sessionCookieName(false))
    expect(sessionCookieName(false)).not.toBe(sessionCookieName(true))
  })

  it('reads nothing for a page that would not stream anyway', async () => {
    const hook = renderRoute()

    await hook({ canStream: false, prefersStream: true }, { event: {} })
    await hook({ canStream: true, prefersStream: false }, { event: {} })

    expect(readSealedSession).not.toHaveBeenCalled()
  })

  it('reads the session under the configured cookie name', async () => {
    const hook = renderRoute()
    ;(__test.runtimeConfig.lukk as Record<string, unknown>).cookieNamespace = 'admin'
    await hook({ canStream: true, prefersStream: true }, { event: {} })

    expect(readSealedSession).toHaveBeenCalledWith({}, 'p'.repeat(32), '__Host-lukk-admin-session')

    __test.runtimeConfig.lukk = undefined as unknown as Record<string, unknown>
    await hook({ canStream: true, prefersStream: true }, { event: {} })
    expect(readSealedSession).toHaveBeenLastCalledWith({}, undefined, '__Host-lukk-session')
  })
})

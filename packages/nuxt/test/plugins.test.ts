import { afterEach, describe, expect, it, vi } from 'vitest'
import { READY_KEY } from '../src/runtime/keys'
import { restoreState } from '../src/runtime/utils/restore-state'
import { __test, useState } from './mocks/imports'

const captured: {
  hooks?: Record<string, (...a: unknown[]) => unknown>
  client?: { refreshTokens: ReturnType<typeof vi.fn> }
} = {}
vi.mock('lukk-core', async importActual => ({
  ...(await importActual<typeof import('lukk-core')>()),
  createLukkClient: vi.fn((hooks: Record<string, (...a: unknown[]) => unknown>) => {
    captured.hooks = hooks
    captured.client = { refreshTokens: vi.fn().mockResolvedValue({ access_token: 'fresh', expires_in: 900 }) }
    return captured.client
  }),
}))

const initSession = vi.fn()
const loggedIn = { value: false }
const fetchUser = vi.fn()
const user: { value: { abilities?: string[] } | null } = { value: null }
vi.mock('../src/runtime/composables/useLukkAuth', () => ({ useLukkAuth: () => ({ initSession, loggedIn, fetchUser, user }) }))

// eslint-disable-next-line import/first
import clientPlugin, { REPLACED_SESSION_RETRY_DELAY_MS } from '../src/runtime/plugins/client'
// eslint-disable-next-line import/first
import sessionPlugin from '../src/runtime/plugins/session.client'

afterEach(() => { __test.reset(); captured.hooks = undefined; loggedIn.value = false; user.value = null; vi.clearAllMocks() })

describe('client plugin', () => {
  it('targets the lukk URL in direct mode and wires the token hooks', async () => {
    __test.runtimeConfig.public.lukk = { mode: 'direct', baseURL: 'https://api/auth', confirmationHeader: 'X-Lukk-Confirmation' }
    const result = (clientPlugin as unknown as () => { provide: { lukk: unknown } })()
    const h = captured.hooks!

    expect(result.provide.lukk).toBeDefined()
    expect(h.baseURL).toBe('https://api/auth')
    expect(await h.getAccessToken()).toBeNull()
    expect(await h.getConfirmationToken()).toBeNull()
    await h.onTokens({ access_token: 'a', expires_in: 900 })
    expect(await h.getAccessToken()).toBe('a')
    h.onUnauthenticated()
    expect(await h.getAccessToken()).toBeNull()
    expect(await h.refresh()).toEqual({ access_token: 'fresh', expires_in: 900 })
  })

  it('targets the local proxy in bff mode', () => {
    __test.runtimeConfig.public.lukk = { mode: 'bff', baseURL: '', confirmationHeader: 'X-Lukk-Confirmation' }
    ;(clientPlugin as unknown as () => unknown)()
    expect(captured.hooks!.baseURL).toBe('/api/_lukk')
  })

  it('provides $lukkRefresh as ONE single-flight shared with the client (concurrent → one refresh)', async () => {
    __test.runtimeConfig.public.lukk = { mode: 'direct', baseURL: 'https://api/auth', confirmationHeader: 'X' }
    const { provide } = (clientPlugin as unknown as () => { provide: { lukkRefresh: () => Promise<unknown> } })()

    const [a, b] = await Promise.all([provide.lukkRefresh(), provide.lukkRefresh()])
    expect(a).toEqual({ access_token: 'fresh', expires_in: 900 })
    expect(b).toBe(a)
    expect(captured.client!.refreshTokens).toHaveBeenCalledTimes(1)
    // the shared refresh also updated the in-memory access token
    expect(await captured.hooks!.getAccessToken()).toBe('fresh')
  })

  it('reloads the user when the BFF refuses to renew a session another tab replaced', async () => {
    // This tab still shows that session. Reloading the user makes it show what the browser now holds.
    __test.runtimeConfig.public.lukk = { mode: 'bff', baseURL: '', confirmationHeader: 'X' }
    const { provide } = (clientPlugin as unknown as () => { provide: { lukkRefresh: () => Promise<unknown> } })()
    captured.client!.refreshTokens.mockRejectedValueOnce({ status: 409 })
    fetchUser.mockResolvedValue(undefined)

    expect(await provide.lukkRefresh()).toBeNull()
    expect(fetchUser).toHaveBeenCalledOnce()

    captured.client!.refreshTokens.mockRejectedValueOnce({ status: 401 })
    fetchUser.mockClear()
    expect(await provide.lukkRefresh()).toBeNull()
    expect(fetchUser).not.toHaveBeenCalled()
  })

  it('$lukkRefresh resolves null when the refresh fails', async () => {
    __test.runtimeConfig.public.lukk = { mode: 'direct', baseURL: 'https://api/auth', confirmationHeader: 'X' }
    const { provide } = (clientPlugin as unknown as () => { provide: { lukkRefresh: () => Promise<unknown> } })()
    captured.client!.refreshTokens.mockRejectedValueOnce(new Error('revoked'))
    expect(await provide.lukkRefresh()).toBeNull()
  })
})

describe('client plugin — $lukkRestore', () => {
  type Provide = { lukkRefresh: () => Promise<unknown>, lukkRestore: () => Promise<{ pair: unknown, unavailable: boolean }> }
  const setup = () => {
    __test.runtimeConfig.public.lukk = { mode: 'bff', baseURL: '', confirmationHeader: 'X' }
    return (clientPlugin as unknown as () => { provide: Provide })().provide
  }

  it('hands back the pair on success', async () => {
    const { lukkRestore } = setup()
    await expect(lukkRestore()).resolves.toEqual({ pair: { access_token: 'fresh', expires_in: 900 }, unavailable: false })
  })

  it.each([
    ['a 401', { status: 401, message: 'Unauthenticated.' }],
    ['a 403', { status: 403, message: 'Forbidden.' }],
    // ofetch's shape — what a custom `$fetch`-based transport rejects with.
    ['an ofetch 403', { statusCode: 403, statusMessage: 'Forbidden' }],
  ])('reports %s as "no session", not as unavailable', async (_, error) => {
    const { lukkRestore } = setup()
    captured.client!.refreshTokens.mockRejectedValueOnce(error)
    await expect(lukkRestore()).resolves.toEqual({ pair: null, unavailable: false })
  })

  it.each([
    ['a throttled refresh (429)', { status: 429, message: 'Too Many Attempts.' }],
    ['a BFF upstream failure (503)', { status: 503, message: 'Unauthenticated.' }],
    ['an unreachable server (no status)', new TypeError('Failed to fetch')],
  ])('reports %s as unavailable', async (_, error) => {
    const { lukkRestore } = setup()
    captured.client!.refreshTokens.mockRejectedValueOnce(error)
    await expect(lukkRestore()).resolves.toEqual({ pair: null, unavailable: true })
  })

  it('asks once more when the BFF says the session was replaced, since the browser likely holds the newer one', async () => {
    // Another tab signed in while this tab's restore was out: the proxy refuses to re-seal the old
    // session (409). The retry carries the cookie that sign-in set.
    vi.useFakeTimers()
    const { lukkRestore } = setup()
    captured.client!.refreshTokens.mockRejectedValueOnce({ status: 409, message: 'The session was replaced.' })

    const restoring = lukkRestore()
    // Not straight away: the server records the replacement before that sign-in's cookie reaches us.
    await vi.advanceTimersByTimeAsync(REPLACED_SESSION_RETRY_DELAY_MS - 1)
    expect(captured.client!.refreshTokens).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)

    await expect(restoring).resolves.toEqual({ pair: { access_token: 'fresh', expires_in: 900 }, unavailable: false })
    expect(captured.client!.refreshTokens).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })

  it('reports a second replaced answer as signed out — a retry could never succeed — and stops there', async () => {
    // This browser still holds the replaced session (the sign-in's response was lost). "Couldn't tell"
    // would offer a retry that fails for as long as the server remembers the replacement.
    vi.useFakeTimers()
    const { lukkRestore } = setup()
    captured.client!.refreshTokens
      .mockRejectedValueOnce({ statusCode: 409 })
      .mockRejectedValueOnce({ status: 409 })

    const restoring = lukkRestore()
    await vi.advanceTimersByTimeAsync(REPLACED_SESSION_RETRY_DELAY_MS)

    await expect(restoring).resolves.toEqual({ pair: null, unavailable: false })
    expect(captured.client!.refreshTokens).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })

  it('shares ONE refresh with $lukkRefresh, so a restore cannot replay the rotating token', async () => {
    // Reuse detection revokes the whole family on a replayed refresh token — two concurrent refreshes
    // from boot + a 401 retry would log the user out everywhere.
    const { lukkRefresh, lukkRestore } = setup()
    await Promise.all([lukkRestore(), lukkRefresh()])
    expect(captured.client!.refreshTokens).toHaveBeenCalledTimes(1)
  })
})

describe('plugin names consumers depend on', () => {
  it('keeps the names the docs tell apps to `dependsOn`, and the order between them', () => {
    // An unknown `dependsOn` name is ignored by Nuxt, so renaming either plugin would silently put an
    // app's `whenReady()` plugin back in front of the restore — and deadlock its startup.
    expect((clientPlugin as unknown as { meta: unknown }).meta).toEqual({ name: 'lukk:client' })
    expect((sessionPlugin as unknown as { meta: unknown }).meta).toEqual({ name: 'lukk:session-restore', dependsOn: ['lukk:client'] })
  })
})

describe('session.client plugin', () => {
  it('restores the session on load when not already logged in', async () => {
    await (sessionPlugin as unknown as () => Promise<void>)()
    expect(initSession).toHaveBeenCalledOnce()
  })

  it('skips the client restore when SSR already hydrated the user', async () => {
    loggedIn.value = true
    await (sessionPlugin as unknown as () => Promise<void>)()
    expect(initSession).not.toHaveBeenCalled()
  })
})

describe('session.client plugin — readiness', () => {
  const run = () => (sessionPlugin as unknown as () => Promise<void>)()
  const ready = () => useState<boolean>(READY_KEY, () => false)

  it('marks the session resolved once the restore settles', async () => {
    await run()
    expect(ready().value).toBe(true)
    // The app-scoped copy too — the one `clearNuxtState()` cannot reset.
    expect(restoreState(__test.nuxtApp).restored.value).toBe(true)
  })

  it('still restores when a cached payload claims ready but nobody is signed in', async () => {
    // `ready` alone must never short-circuit the client restore: only a hydrated USER does. A payload
    // served from a shared cache could carry a stale `ready`, and skipping on it would strand a
    // signed-in visitor as anonymous.
    ready().value = true
    await run()
    expect(initSession).toHaveBeenCalledOnce()
  })

  it('is NOT resolved while the restore is still in flight', async () => {
    // A waiter released before the refresh returns would read `loggedIn: false` for a signed-in
    // visitor — the exact ambiguity the flag exists to remove.
    let finish!: () => void
    initSession.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve }))

    const pending = run()
    // A MACROtask, not one microtask: setting `ready` a few ticks early — still mid-restore — passed
    // a single `await Promise.resolve()`.
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(ready().value).toBe(false)
    expect(restoreState(__test.nuxtApp).started).toBe(true)
    expect(restoreState(__test.nuxtApp).restored.value).toBe(false)

    finish()
    await pending
    expect(ready().value).toBe(true)
  })

  it('marks it resolved when SSR already hydrated the user, without a restore', async () => {
    loggedIn.value = true
    await run()
    expect(initSession).not.toHaveBeenCalled()
    expect(ready().value).toBe(true)
  })

  it('still marks it resolved when the restore throws, so no waiter hangs', async () => {
    // A settled-as-signed-out session is recoverable; a `whenReady()` that never resolves is not.
    initSession.mockRejectedValueOnce(new Error('boom'))

    await expect(run()).rejects.toThrow('boom')
    expect(ready().value).toBe(true)
  })
})

describe('keeping abilities in step with a refreshed token', () => {
  function boot() {
    __test.runtimeConfig.public.lukk = { mode: 'direct', baseURL: 'https://api/auth', confirmationHeader: 'X-Lukk-Confirmation' }

    return (clientPlugin as unknown as () => { provide: { lukkRefresh: () => Promise<unknown> } })()
  }

  it('reloads the user after a refresh, so a re-derived grant reaches the UI', async () => {
    // Abilities are re-derived on EVERY mint server-side — that is what makes revoking one take
    // effect within `access_ttl`. The client only learns a grant through the user resource, so
    // without this a refreshed token carried a new grant while the UI still rendered from the old
    // one: a control stayed visible until it 403'd, or a newly-granted one stayed hidden.
    user.value = { abilities: ['orders.read'] }
    const { provide } = boot()

    await provide.lukkRefresh()
    await Promise.resolve() // the resync is fire-and-forget, so let its microtask run

    expect(fetchUser).toHaveBeenCalledOnce()
  })

  it('does not reload the user for an app that does not use abilities', async () => {
    // An absent `abilities` key means the server doesn't publish them; that app must not pay an
    // extra request on every refresh for a feature it never turned on.
    user.value = {}
    const { provide } = boot()

    await provide.lukkRefresh()
    await Promise.resolve()

    expect(fetchUser).not.toHaveBeenCalled()
  })

  it('does not reload the user when nobody is signed in', async () => {
    const { provide } = boot()

    await provide.lukkRefresh()
    await Promise.resolve()

    expect(fetchUser).not.toHaveBeenCalled()
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { ACCESS_KEY, READY_KEY } from '../src/runtime/keys'
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
const logout = vi.fn(async () => {})
const loggedIn = { value: false }
const fetchUser = vi.fn()
const user: { value: { abilities?: string[] } | null } = { value: null }
const restoreFailed = { value: false }
vi.mock('../src/runtime/composables/useLukkAuth', () => ({ useLukkAuth: () => ({ initSession, loggedIn, fetchUser, user, logout, restoreFailed }) }))

// eslint-disable-next-line import/first
import clientPlugin, { REPLACED_SESSION_RETRY_DELAY_MS } from '../src/runtime/plugins/client'
// eslint-disable-next-line import/first
import sessionPlugin from '../src/runtime/plugins/session.client'

afterEach(() => { __test.reset(); captured.hooks = undefined; loggedIn.value = false; restoreFailed.value = false; user.value = null; vi.clearAllMocks(); vi.useRealTimers() })

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

describe('session.client plugin — a logout the previous page never finished', () => {
  // A page that navigated away right after logout() sent it on pagehide, which a browser fires only once
  // the next page's response is in — so this page (and a BFF server render) could still carry the session.
  const store = new Map<string, string>()
  const fakeStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
  }

  it('finishes it before restoring anything — reading this app\'s note, not another on the origin', async () => {
    vi.stubGlobal('sessionStorage', fakeStorage)
    restoreState(__test.nuxtApp).scope = '/admin/'
    store.set('lukk:logging-out:/admin/', JSON.stringify({ at: Date.now() }))
    loggedIn.value = true // the server rendered the old session

    let finishing: number | undefined
    logout.mockImplementationOnce(async () => { finishing = restoreState(__test.nuxtApp).finishingLogout })

    await (sessionPlugin as unknown as () => Promise<void>)()

    expect(logout).toHaveBeenCalledOnce()
    expect(finishing).toBe(JSON.parse(store.get('lukk:logging-out:/admin/')!).at) // finishing THAT logout, not a new one
    expect(initSession).not.toHaveBeenCalled()
    expect(useState<boolean>(READY_KEY, () => false).value).toBe(true)
    vi.unstubAllGlobals()
    store.clear()
  })

  it('restores instead when a sign-in sent meanwhile in another tab made that logout moot', async () => {
    vi.stubGlobal('sessionStorage', fakeStorage)
    const shared = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (k: string) => shared.get(k) ?? null, setItem: (k: string, v: string) => { shared.set(k, v) } })
    const noted = Date.now()
    store.set('lukk:logging-out:/', JSON.stringify({ at: noted }))
    logout.mockImplementationOnce(async () => {
      shared.set('lukk:signed-in-at:/', String(noted)) // while it waited for the lock
      restoreState(__test.nuxtApp).logoutStoodDown = true
    })

    await (sessionPlugin as unknown as () => Promise<void>)()

    expect(logout).toHaveBeenCalledOnce()
    expect(initSession).toHaveBeenCalledOnce()
    expect(restoreState(__test.nuxtApp).logoutStoodDown).toBe(false) // not left for a later logout on this page
    vi.unstubAllGlobals()
    store.clear()
  })

  it('still resolves the session when that logout fails', async () => {
    vi.stubGlobal('sessionStorage', fakeStorage)
    store.set('lukk:logging-out:/', JSON.stringify({ at: Date.now() }))
    logout.mockRejectedValueOnce({ status: 503 })

    await expect((sessionPlugin as unknown as () => Promise<void>)()).resolves.toBeUndefined()
    expect(useState<boolean>(READY_KEY, () => false).value).toBe(true)
    vi.unstubAllGlobals()
    store.clear()
  })

  describe('direct mode, for a known session', () => {
    const run = () => (sessionPlugin as unknown as () => Promise<void>)()
    const jwt = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`
    const restoresAs = (fid: string | undefined) => initSession.mockImplementationOnce(async () => {
      loggedIn.value = fid !== undefined
      useState<string | null>(ACCESS_KEY, () => null).value = fid === undefined ? null : jwt({ sub: 1, fid })
    })
    afterEach(() => { vi.unstubAllGlobals(); store.clear() })

    it('restores, and ends what it restored when it is the session the logout was for', async () => {
      vi.stubGlobal('sessionStorage', fakeStorage)
      store.set('lukk:logging-out:/', JSON.stringify({ at: Date.now(), fid: 'F1' }))
      restoresAs('F1')
      logout.mockRejectedValueOnce({ status: 503 }) // swallowed like the others

      await run()

      expect(initSession).toHaveBeenCalledOnce()
      expect(logout).toHaveBeenCalledOnce()
      expect(restoreState(__test.nuxtApp).finishingLogout).toBeUndefined() // a plain logout: that session, confirmed
    })

    it('finishes the logout for an app with no user endpoint, where nothing ever reads as logged in', async () => {
      vi.stubGlobal('sessionStorage', fakeStorage)
      store.set('lukk:logging-out:/', JSON.stringify({ at: Date.now(), fid: 'F1' }))
      // `loadUser` skips without an endpoint, so `loggedIn` stays false even though the restore rotated
      // and produced a token for exactly the session the note names.
      initSession.mockImplementationOnce(async () => {
        useState<string | null>(ACCESS_KEY, () => null).value = `h.${Buffer.from(JSON.stringify({ sub: 1, fid: 'F1' })).toString('base64url')}.s`
      })

      await run()

      expect(logout).toHaveBeenCalledOnce()
    })

    it('keeps a newer session the cookie holds by now — from another tab, an SSO callback, anywhere — and drops the note', async () => {
      vi.stubGlobal('sessionStorage', fakeStorage)
      store.set('lukk:logging-out:/', JSON.stringify({ at: Date.now(), fid: 'F1' }))
      restoresAs('F2')
      const announce = vi.fn()
      restoreState(__test.nuxtApp).announce = announce

      await run()

      expect(logout).not.toHaveBeenCalled()
      expect(store.has('lukk:logging-out:/')).toBe(false)
      expect(announce).not.toHaveBeenCalled() // that sign-in announced itself
    })

    it('drops the note when there was no session left to restore — and tells other tabs, which still show the account', async () => {
      vi.stubGlobal('sessionStorage', fakeStorage)
      store.set('lukk:logging-out:/', JSON.stringify({ at: Date.now(), fid: 'F1' }))
      restoresAs(undefined)
      const announce = vi.fn()
      restoreState(__test.nuxtApp).announce = announce

      await run()

      expect(logout).not.toHaveBeenCalled()
      expect(store.has('lukk:logging-out:/')).toBe(false)
      expect(announce).toHaveBeenCalledOnce()
    })

    it('keeps the note when the restore couldn\'t tell (lukk unreachable), for the next load within its minute', async () => {
      vi.stubGlobal('sessionStorage', fakeStorage)
      store.set('lukk:logging-out:/', JSON.stringify({ at: Date.now(), fid: 'F1' }))
      initSession.mockImplementationOnce(async () => { restoreFailed.value = true })

      await run()

      expect(logout).not.toHaveBeenCalled()
      expect(store.has('lukk:logging-out:/')).toBe(true)
    })
  })

  describe('BFF mode', () => {
    const run = () => (sessionPlugin as unknown as () => Promise<void>)()
    afterEach(() => { vi.unstubAllGlobals(); store.clear() })

    /** A document whose jar keeps name=value and records every write. */
    function jar(initial: Record<string, string>) {
      const cookies = new Map(Object.entries(initial))
      const writes: string[] = []
      vi.stubGlobal('document', {
        get cookie() { return [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') },
        set cookie(line: string) {
          writes.push(line)
          const [name, value] = line.split(';')[0]!.split('=') as [string, string]
          if (line.includes('Max-Age=0')) cookies.delete(name)
          else cookies.set(name, value)
        },
      })
      return { cookies, writes }
    }

    it('finishes a logout the server couldn\'t — its note is still pending — without holding startup, renewing the note\'s minute first', async () => {
      __test.runtimeConfig.public.lukk = { mode: 'bff', logoutCookie: '__Host-lukk-logout' }
      const { writes } = jar({ 'theme': 'dark', '__Host-lukk-logout': '1' })
      let finishing: number | undefined
      logout.mockImplementationOnce(() => { finishing = restoreState(__test.nuxtApp).finishingLogout; return new Promise(() => {}) }) // lukk hanging

      await run()

      expect(writes).toEqual(['__Host-lukk-logout=1; Path=/; Max-Age=60; SameSite=Strict; Secure'])
      expect(logout).toHaveBeenCalledOnce()
      expect(finishing).toEqual(expect.any(Number)) // finishing that one: it stands down if the note stops saying pending
      expect(initSession).not.toHaveBeenCalled()
      expect(useState<boolean>(READY_KEY, () => false).value).toBe(true)
    })

    it('restores the newer session once that logout stood down for it, and swallows a failure', async () => {
      __test.runtimeConfig.public.lukk = { mode: 'bff', logoutCookie: '__Host-lukk-logout' }
      jar({ '__Host-lukk-logout': '1' })
      logout.mockImplementationOnce(async () => { restoreState(__test.nuxtApp).logoutStoodDown = true })

      await run()
      await vi.waitFor(() => expect(initSession).toHaveBeenCalledOnce())
      expect(restoreState(__test.nuxtApp).logoutStoodDown).toBe(false)

      initSession.mockClear()
      logout.mockResolvedValueOnce(undefined) // sent: nothing to restore
      await run()
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(initSession).not.toHaveBeenCalled()

      logout.mockRejectedValueOnce({ status: 503 })
      await expect(run()).resolves.toBeUndefined()
      await new Promise(resolve => setTimeout(resolve, 0))
    })

    it('restores nothing, and tells other tabs, when the server finished the logout for this page — then drops its answer', async () => {
      __test.runtimeConfig.public.lukk = { mode: 'bff', logoutCookie: '__Host-lukk-logout', signedOutCookie: '__Host-lukk-signed-out' }
      const { cookies } = jar({ 'theme': 'dark', '__Host-lukk-signed-out': '1' })
      const announce = vi.fn()
      restoreState(__test.nuxtApp).announce = announce

      await run()

      expect(initSession).not.toHaveBeenCalled()
      expect(logout).not.toHaveBeenCalled()
      expect(announce).toHaveBeenCalledOnce()
      expect(cookies.has('__Host-lukk-signed-out')).toBe(false)
    })

    it('restores as usual without the note cookie — a per-tab note isn\'t read in BFF mode', async () => {
      __test.runtimeConfig.public.lukk = { mode: 'bff', logoutCookie: '__Host-lukk-logout' }
      vi.stubGlobal('document', { cookie: 'theme=dark' })
      vi.stubGlobal('sessionStorage', fakeStorage)
      store.set('lukk:logging-out:/', JSON.stringify({ at: Date.now() }))

      await run()

      expect(logout).not.toHaveBeenCalled()
      expect(initSession).toHaveBeenCalledOnce()
    })
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

  it('reloads the user when the refreshed token belongs to a different account than the one on screen', async () => {
    // Another tab signed in, or a refresh outlived this tab's handover: the shared refresh cookie now
    // belongs to someone else, and without this the tab kept one account's name while acting as another.
    const token = (sub: string) => `h.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.s`
    user.value = {} // an app that does not use abilities
    restoreState(__test.nuxtApp).subject = 'A'
    const { provide } = boot()

    captured.client!.refreshTokens.mockResolvedValueOnce({ access_token: token('A'), expires_in: 900 })
    await provide.lukkRefresh()
    await Promise.resolve()
    expect(fetchUser).not.toHaveBeenCalled()

    captured.client!.refreshTokens.mockResolvedValueOnce({ access_token: token('B'), expires_in: 900 })
    await provide.lukkRefresh()
    await Promise.resolve()
    expect(fetchUser).toHaveBeenCalledOnce()
  })

  it('reloads on every switch, not only the first — the re-entry guard is released after each', async () => {
    const token = (sub: string) => `h.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.s`
    user.value = {}
    restoreState(__test.nuxtApp).subject = 'A'
    fetchUser.mockResolvedValue(undefined)
    const { provide } = boot()

    captured.client!.refreshTokens.mockResolvedValueOnce({ access_token: token('B'), expires_in: 900 })
    await provide.lukkRefresh()
    await new Promise(resolve => setTimeout(resolve, 0))
    captured.client!.refreshTokens.mockResolvedValueOnce({ access_token: token('C'), expires_in: 900 })
    await provide.lukkRefresh()
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(fetchUser).toHaveBeenCalledTimes(2)
  })

  it('does not re-enter while its own user reload triggers another refresh', async () => {
    // `fetchUser`'s own 401 refreshes again; without the guard that refresh reloaded again, and again.
    const token = (sub: string) => `h.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.s`
    user.value = { abilities: ['orders.read'] }
    const { provide } = boot()
    fetchUser.mockImplementation(async () => { await provide.lukkRefresh() })
    captured.client!.refreshTokens.mockResolvedValue({ access_token: token('A'), expires_in: 900 })

    await provide.lukkRefresh()
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(fetchUser).toHaveBeenCalledOnce()
  })

  it('does not treat a token without a subject as a switch', async () => {
    user.value = {}
    restoreState(__test.nuxtApp).subject = 'A'
    const { provide } = boot()

    captured.client!.refreshTokens.mockResolvedValueOnce({ access_token: 'not-a-jwt', expires_in: 900 })
    await provide.lukkRefresh()
    await Promise.resolve()

    expect(fetchUser).not.toHaveBeenCalled()
  })

  it('does not treat an unknown subject as a switch', async () => {
    user.value = {}
    const { provide } = boot() // no subject recorded (BFF, or a token without `sub`)

    captured.client!.refreshTokens.mockResolvedValueOnce({ access_token: `h.${Buffer.from('{"sub":"B"}').toString('base64url')}.s`, expires_in: 900 })
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

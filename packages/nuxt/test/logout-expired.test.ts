import { afterEach, describe, expect, it, vi } from 'vitest'
import { ACCESS_KEY } from '../src/runtime/keys'
import { REFRESH_SETTLE_TIMEOUT, restoreState } from '../src/runtime/utils/restore-state'
import { __test, useState } from './mocks/imports'

// The REAL lukk-core client and the REAL plugin + composable, with only `fetch` stubbed. The bug this
// pins lived in the handoff between core's own 401 retry and the plugin's refresh gate — a test that
// mocked either side (as the session-generation suite mocks core) could not see it.
const { api } = vi.hoisted(() => ({ api: vi.fn() }))
vi.mock('../src/runtime/composables/useLukkFetch', () => ({ useLukkFetch: () => api }))

// eslint-disable-next-line import/first
import clientPlugin from '../src/runtime/plugins/client'
// eslint-disable-next-line import/first
import { useLukkAuth } from '../src/runtime/composables/useLukkAuth'

const json = (body: unknown, status = 200) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function boot(mode: 'direct' | 'bff', lukk: (path: string, init: RequestInit) => Response) {
  const calls: { path: string, bearer: string | null }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const path = new URL(String(url), 'https://app.test').pathname.replace(/^\/(auth|api\/_lukk)/, '')
    calls.push({ path, bearer: new Headers(init.headers).get('authorization') })
    return lukk(path, init)
  }))
  __test.runtimeConfig.public.lukk = { mode, baseURL: 'https://api.test/auth', confirmationHeader: 'X-Lukk-Confirmation', userEndpoint: '', userKey: '' }
  const { provide } = (clientPlugin as unknown as () => { provide: Record<string, unknown> })()
  Object.assign(__test.nuxtApp, Object.fromEntries(Object.entries(provide).map(([k, v]) => [`$${k}`, v])))
  return calls
}

afterEach(() => { __test.reset(); vi.useRealTimers(); vi.unstubAllGlobals(); api.mockReset() })

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

describe('logout() with an access token lukk rejects', () => {
  it('renews it and logs out at once — it does not wait on itself for the settle timeout', async () => {
    // An idle user: the in-memory token expired. Core's refresh used to wait on this logout, which was
    // waiting on that refresh, until REFRESH_SETTLE_TIMEOUT broke the cycle.
    vi.useFakeTimers()
    let renewed = false
    const calls = boot('direct', (path) => {
      if (path === '/refresh') { renewed = true; return json({ access_token: 'fresh', expires_in: 900 }) }
      return renewed ? json(undefined, 204) : json({ message: 'Unauthenticated.' }, 401)
    })
    useState<string | null>(ACCESS_KEY, () => null).value = 'expired'
    const auth = useLukkAuth()

    let done = false
    const loggingOut = auth.logout().then(() => { done = true })
    await vi.advanceTimersByTimeAsync(0) // settle microtasks only; no timer may be needed

    expect(done).toBe(true)
    await loggingOut
    expect(calls).toEqual([
      { path: '/logout', bearer: 'Bearer expired' },
      { path: '/refresh', bearer: 'Bearer expired' },
      { path: '/logout', bearer: 'Bearer fresh' },
    ])
    expect(useState<string | null>(ACCESS_KEY, () => null).value).toBeNull()
  })

  it('does not wait on itself under the cross-tab lock either — the renewal shares the logout\'s hold', async () => {
    vi.useFakeTimers()
    let requests = 0
    let held = false
    vi.stubGlobal('window', {})
    vi.stubGlobal('navigator', {
      locks: {
        request: (_name: string, _options: unknown, callback: () => Promise<void>) => {
          requests++
          if (held) return new Promise(() => {}) // a second acquisition would wait forever
          held = true
          return callback().finally(() => { held = false })
        },
      },
    })
    let renewed = false
    const calls = boot('direct', (path) => {
      if (path === '/refresh') { renewed = true; return json({ access_token: 'fresh', expires_in: 900 }) }
      return renewed ? json(undefined, 204) : json({ message: 'Unauthenticated.' }, 401)
    })
    useState<string | null>(ACCESS_KEY, () => null).value = 'expired'

    let done = false
    const loggingOut = useLukkAuth().logout().then(() => { done = true })
    await vi.advanceTimersByTimeAsync(0)

    expect(done).toBe(true)
    await loggingOut
    expect(requests).toBe(1)
    expect(calls.map(c => c.path)).toEqual(['/logout', '/refresh', '/logout'])
  })

  it('sends the logout at once when the page starts to unload while it is still waiting', async () => {
    // Waiting for another tab's lock (or a refresh already out), then navigating away, used to cancel it.
    const listeners = new Map<string, () => void>()
    vi.stubGlobal('window', {
      addEventListener: (name: string, fn: () => void) => { listeners.set(name, fn) },
      removeEventListener: (name: string) => { listeners.delete(name) },
    })
    const lockHeldElsewhere = new Promise<void>(() => {})
    vi.stubGlobal('navigator', { locks: { request: () => lockHeldElsewhere } })
    const calls = boot('direct', () => json(undefined, 204))
    useState<string | null>(ACCESS_KEY, () => null).value = 'A'

    void useLukkAuth().logout()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(calls.map(c => c.path)).toEqual([]) // still waiting for the lock

    listeners.get('pagehide')!()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(calls).toEqual([{ path: '/logout', bearer: 'Bearer A' }])

    listeners.get('pagehide')?.() // a second pagehide sends nothing more
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(calls).toHaveLength(1)
  })

  it('does not send it again when the lock arrives after the page already sent it', async () => {
    // A bfcache'd page can resume: the waiting logout then continues — and must only clean up.
    const listeners = new Map<string, () => void>()
    vi.stubGlobal('window', {
      addEventListener: (name: string, fn: () => void) => { listeners.set(name, fn) },
      removeEventListener: (name: string) => { listeners.delete(name) },
    })
    let grant!: () => void
    const granted = new Promise<void>((resolve) => { grant = resolve })
    vi.stubGlobal('navigator', { locks: { request: async (_n: string, _o: unknown, callback: () => Promise<void>) => { await granted; return callback() } } })
    const calls = boot('direct', () => json(undefined, 204))
    useState<string | null>(ACCESS_KEY, () => null).value = 'A'
    const auth = useLukkAuth()
    auth.user.value = { id: 1 }

    const loggingOut = auth.logout()
    await new Promise(resolve => setTimeout(resolve, 0))
    listeners.get('pagehide')!()
    grant()
    await loggingOut

    expect(calls.map(c => c.path)).toEqual(['/logout'])
    expect(auth.loggedIn.value).toBe(false) // cleaned up all the same
  })

  it('sends it again when the lock arrives and the send on the way out had failed', async () => {
    // A page restored from the back/forward cache resumes the waiting logout; a lost early send would
    // otherwise leave the session live.
    const listeners = new Map<string, () => void>()
    vi.stubGlobal('window', {
      addEventListener: (name: string, fn: () => void) => { listeners.set(name, fn) },
      removeEventListener: (name: string) => { listeners.delete(name) },
    })
    let grant!: () => void
    const granted = new Promise<void>((resolve) => { grant = resolve })
    vi.stubGlobal('navigator', { locks: { request: async (_n: string, _o: unknown, callback: () => Promise<void>) => { await granted; return callback() } } })
    let attempts = 0
    const calls = boot('direct', () => {
      if (++attempts <= 2) throw new TypeError('Failed to fetch') // the early send and its keepalive-less retry
      return json(undefined, 204)
    })
    useState<string | null>(ACCESS_KEY, () => null).value = 'A'

    const loggingOut = useLukkAuth().logout()
    await new Promise(resolve => setTimeout(resolve, 0))
    listeners.get('pagehide')!()
    await new Promise(resolve => setTimeout(resolve, 0))
    grant()
    await loggingOut

    expect(calls.map(c => c.path)).toEqual(['/logout', '/logout', '/logout'])
  })

  it('does not resend when the send on the way out found no session (401) — the next page\'s server may have ended it', async () => {
    // Resending carried whatever cookie the browser held by then: a page restored from the back/forward
    // cache after the visitor signed in again ended that new session.
    const listeners = new Map<string, () => void>()
    vi.stubGlobal('window', {
      addEventListener: (name: string, fn: () => void) => { listeners.set(name, fn) },
      removeEventListener: (name: string) => { listeners.delete(name) },
    })
    let grant!: () => void
    const granted = new Promise<void>((resolve) => { grant = resolve })
    vi.stubGlobal('navigator', { locks: { request: async (_n: string, _o: unknown, callback: () => Promise<void>) => { await granted; return callback() } } })
    const calls = boot('bff', () => json({ message: 'Unauthenticated.' }, 401))

    const loggingOut = useLukkAuth().logout()
    await new Promise(resolve => setTimeout(resolve, 0))
    listeners.get('pagehide')!()
    await new Promise(resolve => setTimeout(resolve, 0))
    grant()
    await loggingOut

    expect(calls.map(c => c.path)).toEqual(['/logout'])
  })

  it('does not resend a failed early send once a sign-in made the logout it finishes moot', async () => {
    const listeners = new Map<string, () => void>()
    vi.stubGlobal('window', {
      addEventListener: (name: string, fn: () => void) => { listeners.set(name, fn) },
      removeEventListener: (name: string) => { listeners.delete(name) },
    })
    let grant!: () => void
    const granted = new Promise<void>((resolve) => { grant = resolve })
    vi.stubGlobal('navigator', { locks: { request: async (_n: string, _o: unknown, callback: () => Promise<void>) => { await granted; return callback() } } })
    const shared = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (k: string) => shared.get(k) ?? null, setItem: (k: string, v: string) => { shared.set(k, v) } })
    let attempts = 0
    const calls = boot('bff', () => {
      if (++attempts <= 2) throw new TypeError('Failed to fetch')
      return json(undefined, 204)
    })
    const noted = Date.now() - 10

    restoreState(__test.nuxtApp).finishingLogout = noted
    const loggingOut = useLukkAuth().logout()
    await new Promise(resolve => setTimeout(resolve, 0))
    listeners.get('pagehide')!()
    await new Promise(resolve => setTimeout(resolve, 0))
    shared.set('lukk:signed-in-at:/', String(noted)) // another tab's sign-in lands while this waits
    grant()
    await loggingOut

    expect(calls.map(c => c.path)).toEqual(['/logout', '/logout']) // the failed early send only
  })

  it('also sends it when the page goes hidden — iOS Safari may never fire pagehide', async () => {
    let onVisibility!: () => void
    let visibility = 'visible'
    vi.stubGlobal('window', { addEventListener: () => {}, removeEventListener: () => {} })
    vi.stubGlobal('document', {
      get visibilityState() { return visibility },
      addEventListener: (_name: string, fn: () => void) => { onVisibility = fn },
      removeEventListener: () => {},
    })
    vi.stubGlobal('navigator', { locks: { request: () => new Promise(() => {}) } })
    const calls = boot('direct', () => json(undefined, 204))
    useState<string | null>(ACCESS_KEY, () => null).value = 'A'

    void useLukkAuth().logout()
    await new Promise(resolve => setTimeout(resolve, 0))
    onVisibility() // still visible: nothing
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(calls).toHaveLength(0)

    visibility = 'hidden'
    onVisibility()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(calls.map(c => c.path)).toEqual(['/logout'])
  })

  it('does not send it twice when the page unloads after the logout already went out', async () => {
    vi.useFakeTimers()
    const listeners: Record<string, () => void> = {}
    vi.stubGlobal('window', {
      addEventListener: (name: string, fn: () => void) => { listeners[name] = fn },
      removeEventListener: () => {},
    })
    const calls = boot('direct', () => json(undefined, 204))

    await useLukkAuth().logout()
    listeners.pagehide!()
    await vi.advanceTimersByTimeAsync(0)

    expect(calls.map(c => c.path)).toEqual(['/logout'])
  })

  it('leaves a note the next page finishes the logout from, and clears it once done', async () => {
    const store = new Map<string, string>()
    vi.stubGlobal('sessionStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v) }, removeItem: (k: string) => { store.delete(k) } })
    let answer!: (r: Response) => void
    boot('direct', () => new Promise<Response>((resolve) => { answer = resolve }) as unknown as Response)
    restoreState(__test.nuxtApp).scope = '/admin/' // this app's own note

    const loggingOut = useLukkAuth().logout()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(JSON.parse(store.get('lukk:logging-out:/admin/')!).at).toBeGreaterThan(0) // the page could be gone before this finishes

    answer(json(undefined, 204))
    await loggingOut
    expect(store.size).toBe(0)
  })

  it('finishing an earlier page\'s logout, stands down if a sign-in was sent after it — sending would end that newer session', async () => {
    const noted = Date.now() - 10
    const store = new Map<string, string>([['lukk:logging-out:/', JSON.stringify({ at: noted })]])
    const shared = new Map<string, string>()
    vi.stubGlobal('sessionStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v) }, removeItem: (k: string) => { store.delete(k) } })
    vi.stubGlobal('localStorage', { getItem: (k: string) => shared.get(k) ?? null, setItem: (k: string, v: string) => { shared.set(k, v) } })

    const calls = boot('bff', () => json(undefined, 204))
    restoreState(__test.nuxtApp).finishingLogout = noted
    const finishing = useLukkAuth().logout()
    expect(restoreState(__test.nuxtApp).finishingLogout).toBeUndefined() // consumed by this call only
    shared.set('lukk:signed-in-at:/', String(noted)) // another tab's sign-in, recorded while this waited
    await finishing
    expect(calls).toEqual([])
  })

  it('finishing an earlier page\'s logout, keeps the note\'s time — and sends even once that note is gone', async () => {
    const noted = Date.now() - 10
    const store = new Map<string, string>([['lukk:logging-out:/', JSON.stringify({ at: noted })]])
    const seen: (string | undefined)[] = []
    vi.stubGlobal('sessionStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v) }, removeItem: (k: string) => { store.delete(k) } })

    const calls = boot('bff', () => { seen.push(store.get('lukk:logging-out:/')); return json(undefined, 204) })
    restoreState(__test.nuxtApp).finishingLogout = noted
    await useLukkAuth().logout()
    expect(seen).toEqual([JSON.stringify({ at: noted })])

    // Aged out while it waited, or cleared by another logout: the session may still be live.
    restoreState(__test.nuxtApp).finishingLogout = Date.now() - 70_000
    await useLukkAuth().logout()
    expect(calls.map(c => c.path)).toEqual(['/logout', '/logout'])
    expect(seen[1]).toBeUndefined()
  })

  it('a new logout re-stamps a failed one\'s note, and a sign-in sent between the two doesn\'t stop it', async () => {
    const store = new Map<string, string>([['lukk:logging-out:/', JSON.stringify({ at: Date.now() - 1_000 })]])
    const shared = new Map<string, string>([['lukk:signed-in-at:/', String(Date.now() - 500)]])
    vi.stubGlobal('sessionStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v) }, removeItem: (k: string) => { store.delete(k) } })
    vi.stubGlobal('localStorage', { getItem: (k: string) => shared.get(k) ?? null, setItem: (k: string, v: string) => { shared.set(k, v) } })
    const seen: number[] = []

    const calls = boot('bff', () => { seen.push(JSON.parse(store.get('lukk:logging-out:/')!).at); return json(undefined, 204) })
    await useLukkAuth().logout()

    expect(calls.map(c => c.path)).toEqual(['/logout'])
    expect(seen[0]).toBeGreaterThan(Number(shared.get('lukk:signed-in-at:/')))
  })

  it('does not send it on the way out either once a sign-in made the logout it finishes moot', async () => {
    const listeners = new Map<string, () => void>()
    vi.stubGlobal('window', {
      addEventListener: (name: string, fn: () => void) => { listeners.set(name, fn) },
      removeEventListener: (name: string) => { listeners.delete(name) },
    })
    vi.stubGlobal('navigator', { locks: { request: () => new Promise<void>(() => {}) } })
    const shared = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (k: string) => shared.get(k) ?? null, setItem: (k: string, v: string) => { shared.set(k, v) } })
    const noted = Date.now() - 10
    const calls = boot('bff', () => json(undefined, 204))

    restoreState(__test.nuxtApp).finishingLogout = noted
    void useLukkAuth().logout()
    await new Promise(resolve => setTimeout(resolve, 0))
    shared.set('lukk:signed-in-at:/', String(noted))
    listeners.get('pagehide')!()
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(calls).toEqual([])
  })

  it('in direct mode, names the session in its note — the in-memory token\'s family', async () => {
    const store = new Map<string, string>()
    vi.stubGlobal('sessionStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v) }, removeItem: (k: string) => { store.delete(k) } })
    const seen: unknown[] = []
    boot('direct', () => { seen.push(JSON.parse(store.get('lukk:logging-out:/')!)); return json(undefined, 204) })
    useState<string | null>(ACCESS_KEY, () => null).value = `h.${Buffer.from(JSON.stringify({ sub: 1, fid: 'fam-7' })).toString('base64url')}.s`

    await useLukkAuth().logout()

    expect(seen).toEqual([{ at: expect.any(Number), fid: 'fam-7' }])
  })

  it('in BFF mode, notes it in the cookie the next page load carries to the server — not in sessionStorage', async () => {
    const jar = new Map<string, string>()
    vi.stubGlobal('document', {
      get cookie() { return [...jar].map(([k, v]) => `${k}=${v}`).join('; ') },
      set cookie(line: string) {
        const [name, value] = line.split(';')[0]!.split('=') as [string, string]
        if (line.includes('Max-Age=0')) jar.delete(name)
        else jar.set(name, value)
      },
    })
    const store = new Map<string, string>()
    vi.stubGlobal('sessionStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v) }, removeItem: (k: string) => { store.delete(k) } })
    const noted: boolean[] = []
    let status = 204
    boot('bff', () => { noted.push(jar.has('__Host-lukk-logout')); return json(status === 204 ? undefined : { message: 'x' }, status) })
    ;(__test.runtimeConfig.public.lukk as Record<string, unknown>).logoutCookie = '__Host-lukk-logout'

    await useLukkAuth().logout()
    expect(noted).toEqual([true]) // there before the request went out
    expect(jar.has('__Host-lukk-logout')).toBe(false) // and gone once it succeeded
    expect(store.size).toBe(0)

    status = 429
    await expect(useLukkAuth().logout()).rejects.toMatchObject({ status: 429 })
    expect(jar.has('__Host-lukk-logout')).toBe(true) // may still be live: the next page load finishes it

    // A 401 the renewal could not follow up (the refresh 401s too here) keeps the note: the session may
    // well be live, and the note is the only thing that would finish the logout later.
    status = 401
    await expect(useLukkAuth().logout()).rejects.toMatchObject({ status: 401 })
    expect(jar.has('__Host-lukk-logout')).toBe(true)
  })

  it('in BFF mode, finishing an earlier page\'s logout doesn\'t note it again, and stands down for a sign-in sent since', async () => {
    const jar = new Map<string, string>([['__Host-lukk-logout', '1']])
    const writes: string[] = []
    vi.stubGlobal('document', {
      get cookie() { return [...jar].map(([k, v]) => `${k}=${v}`).join('; ') },
      set cookie(line: string) {
        writes.push(line)
        const [name, value] = line.split(';')[0]!.split('=') as [string, string]
        if (line.includes('Max-Age=0')) jar.delete(name)
        else jar.set(name, value)
      },
    })
    let grant!: () => void
    let granted = new Promise<void>((resolve) => { grant = resolve })
    vi.stubGlobal('navigator', { locks: { request: async (_n: string, _o: unknown, callback: () => Promise<void>) => { await granted; return callback() } } })
    const calls = boot('bff', () => json(undefined, 204))
    ;(__test.runtimeConfig.public.lukk as Record<string, unknown>).logoutCookie = '__Host-lukk-logout'
    const state = restoreState(__test.nuxtApp)

    const shared = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (k: string) => shared.get(k) ?? null, setItem: (k: string, v: string) => { shared.set(k, v) } })

    const asked = Date.now()
    state.finishingLogout = asked
    const finishing = useLukkAuth().logout()
    expect(writes).toEqual([]) // not written again
    shared.set('lukk:signed-in-at:/', String(asked)) // another tab's sign-in, SENT after this was asked for
    jar.delete('__Host-lukk-logout') // …and its response cleared the note
    grant()
    await finishing
    expect(calls).toEqual([]) // sending would have ended that sign-in
    expect(state.logoutStoodDown).toBe(true) // for the restore plugin, which restores the newer session
    expect(writes).toEqual([])

    // No sign-in since: it sends, and clears the note once done — an aged-out or already-cleared note is
    // not evidence that someone else dealt with this logout.
    state.logoutStoodDown = false
    shared.clear()
    jar.delete('__Host-lukk-logout')
    granted = Promise.resolve()
    state.finishingLogout = Date.now()
    await useLukkAuth().logout()
    expect(calls.map(c => c.path)).toEqual(['/logout'])
    expect(state.logoutStoodDown).toBe(false)
    expect(jar.has('__Host-lukk-logout')).toBe(false)
  })

  it('keeps the note when the logout may have left the session live, and drops it when there was none', async () => {
    const store = new Map<string, string>()
    vi.stubGlobal('sessionStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v) }, removeItem: (k: string) => { store.delete(k) } })

    boot('direct', () => json({ message: 'Too Many Attempts.' }, 429))
    await expect(useLukkAuth().logout()).rejects.toMatchObject({ status: 429 })
    expect(store.has('lukk:logging-out:/')).toBe(true)

    // A 401 whose renewal DID land says the session is gone — that note goes.
    __test.reset()
    let renewed = false
    boot('direct', (path) => {
      if (path === '/refresh') { renewed = true; return json({ access_token: 'fresh', expires_in: 900 }) }
      return json({ message: 'Unauthenticated.' }, 401)
    })
    restoreState(__test.nuxtApp).scope = '/admin/'
    await expect(useLukkAuth().logout()).rejects.toMatchObject({ status: 401 })
    expect(renewed).toBe(true)
    expect(store.has('lukk:logging-out:/admin/')).toBe(false)
    expect(store.has('lukk:logging-out:/')).toBe(true) // the earlier app's note is untouched
  })

  it('fails fast when there is no session left to renew (an erased account, a revoked session)', async () => {
    vi.useFakeTimers()
    const calls = boot('bff', () => json({ message: 'Unauthenticated.' }, 401))
    const auth = useLukkAuth()
    auth.user.value = { id: 1 }

    let settled = false
    const loggingOut = auth.logout().catch((error: unknown) => { settled = true; return error })
    await vi.advanceTimersByTimeAsync(0)

    expect(settled).toBe(true)
    expect(await loggingOut).toMatchObject({ status: 401 })
    expect(calls.map(c => c.path)).toEqual(['/logout', '/refresh'])
    expect(auth.loggedIn.value).toBe(false)
  })

  it.each([
    ['a 500', () => json({ message: 'Server Error' }, 500)],
    ['a 403', () => json({ message: 'Forbidden.' }, 403)],
    ['a 429', () => json({ message: 'Too Many Attempts.' }, 429)],
  ])('does not renew for %s — only an expired token is renewable', async (_, answer) => {
    vi.useFakeTimers()
    const calls = boot('direct', answer)

    await expect(useLukkAuth().logout()).rejects.toBeDefined()
    expect(calls.map(c => c.path)).toEqual(['/logout'])
  })

  it('does not renew for a network failure either (it is sent once more without keepalive, then given up)', async () => {
    vi.useFakeTimers()
    const calls = boot('direct', () => { throw new TypeError('Failed to fetch') })

    await expect(useLukkAuth().logout()).rejects.toBeInstanceOf(TypeError)
    expect(calls.map(c => c.path)).toEqual(['/logout', '/logout'])
  })

  it('does not stall when another request\'s refresh started while the first attempt was out', async () => {
    // That refresh waited on the logout's hold; the renewal then joined it — each waiting on the other
    // until the settle cap. The hold is now per attempt, so the joined refresh goes out as soon as the
    // first attempt answers.
    vi.useFakeTimers()
    const firstAnswer = deferred<Response>()
    let renewed = false
    let logouts = 0
    const calls = boot('direct', (path) => {
      if (path === '/refresh') { renewed = true; return json({ access_token: 'fresh', expires_in: 900 }) }
      if (++logouts === 1) return firstAnswer.promise as unknown as Response
      return renewed ? json(undefined, 204) : json({ message: 'Unauthenticated.' }, 401)
    })
    useState<string | null>(ACCESS_KEY, () => null).value = 'expired'

    let done = false
    const loggingOut = useLukkAuth().logout().then(() => { done = true })
    await vi.advanceTimersByTimeAsync(0)
    const otherRequestsRefresh = (__test.nuxtApp as { $lukkRefresh: () => Promise<unknown> }).$lukkRefresh()
    await vi.advanceTimersByTimeAsync(0)
    expect(calls.map(c => c.path)).toEqual(['/logout']) // held while the first attempt is out

    firstAnswer.resolve(json({ message: 'Unauthenticated.' }, 401))
    await vi.advanceTimersByTimeAsync(0)

    expect(done).toBe(true)
    await Promise.all([loggingOut, otherRequestsRefresh])
    expect(calls.map(c => c.path)).toEqual(['/logout', '/refresh', '/logout'])
  })

  it('holds a sign-in back through the renewal gap, so the logout cannot sign the new session out', async () => {
    const renewal = deferred<Response>()
    let renewed = false
    const calls = boot('direct', (path) => {
      if (path === '/refresh') return renewal.promise.then((r) => { renewed = true; return r }) as unknown as Response
      if (path === '/login') return json({ access_token: 'B', refresh_token: 'rB', expires_in: 900 })
      return renewed ? json(undefined, 204) : json({ message: 'Unauthenticated.' }, 401)
    })
    useState<string | null>(ACCESS_KEY, () => null).value = 'expired'
    const auth = useLukkAuth()

    const loggingOut = auth.logout()
    await new Promise(resolve => setTimeout(resolve, 0)) // first attempt rejected; renewal on the wire
    const signingIn = auth.login({ email: 'b', password: 'p' })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(calls.map(c => c.path)).not.toContain('/login')

    renewal.resolve(json({ access_token: 'fresh', expires_in: 900 }))
    await Promise.all([loggingOut, signingIn])

    await new Promise(resolve => setTimeout(resolve, 0))
    expect(calls.map(c => c.path)).toEqual(['/logout', '/refresh', '/logout', '/login', '/session/claim'])
    expect(useState<string | null>(ACCESS_KEY, () => null).value).toBe('B')
  })

  it('does not let a user reload started by the renewal sign the user back in afterwards', async () => {
    // The renewal's refresh re-syncs a user that carries abilities. That reload captured the generation
    // the logout had already bumped, so landing after the logout it put the user back.
    const slowUser = deferred<unknown>()
    api.mockReturnValue(slowUser.promise)
    let renewed = false
    boot('direct', (path) => {
      if (path === '/refresh') { renewed = true; return json({ access_token: 'fresh', expires_in: 900 }) }
      return renewed ? json(undefined, 204) : json({ message: 'Unauthenticated.' }, 401)
    })
    __test.runtimeConfig.public.lukk.userEndpoint = '/me'
    useState<string | null>(ACCESS_KEY, () => null).value = 'expired'
    const auth = useLukkAuth()
    auth.user.value = { id: 1, abilities: ['orders.read'] }

    await auth.logout()
    expect(api).toHaveBeenCalled() // the reload is out
    slowUser.resolve({ id: 1, abilities: ['orders.read'] })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(auth.loggedIn.value).toBe(false)
  })

  it('still holds back a refresh that starts while the retried logout is out', async () => {
    let answer!: (r: Response) => void
    let renewed = false
    let logouts = 0
    const calls = boot('direct', (path) => {
      if (path === '/refresh') { renewed = true; return json({ access_token: 'fresh', expires_in: 900 }) }
      if (!renewed) return json({ message: 'Unauthenticated.' }, 401)
      if (++logouts > 1) return json(undefined, 204)
      return new Promise<Response>((resolve) => { answer = resolve }) as unknown as Response
    })
    useState<string | null>(ACCESS_KEY, () => null).value = 'expired'

    const loggingOut = useLukkAuth().logout()
    await new Promise(resolve => setTimeout(resolve, 0))
    const refreshing = (__test.nuxtApp as { $lukkRefresh: () => Promise<unknown> }).$lukkRefresh()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(calls.map(c => c.path)).toEqual(['/logout', '/refresh', '/logout'])

    answer(json(undefined, 204))
    await loggingOut
    await refreshing
    // Released only once the logout answered — and, having raced a logout, that refresh's rotation is
    // ended too, with the token it minted.
    expect(calls.map(c => c.path)).toEqual(['/logout', '/refresh', '/logout', '/refresh', '/logout'])
    expect(calls.at(-1)!.bearer).toBe('Bearer fresh')
  })

  it(`resolves long before the ${REFRESH_SETTLE_TIMEOUT}ms cap when the retry succeeds`, async () => {
    let renewed = false
    boot('bff', (path) => {
      if (path === '/refresh') { renewed = true; return json({ ok: true, expires_in: 900 }) }
      return renewed ? json(undefined, 204) : json({ message: 'Unauthenticated.' }, 401)
    })
    const started = Date.now()

    await useLukkAuth().logout()

    expect(Date.now() - started).toBeLessThan(1_000)
  })
})

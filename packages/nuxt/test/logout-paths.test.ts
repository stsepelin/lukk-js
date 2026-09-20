import { afterEach, describe, expect, it, vi } from 'vitest'
import { ACCESS_KEY, CHALLENGE_KEY, CONFIRMATION_KEY, CONFIRMED_KEY, READY_KEY, RESTORE_FAILED_KEY } from '../src/runtime/keys'
import { restoreState } from '../src/runtime/utils/restore-state'
import { __test, useState } from './mocks/imports'

const { api } = vi.hoisted(() => ({ api: vi.fn() }))
vi.mock('../src/runtime/composables/useLukkFetch', () => ({ useLukkFetch: () => api }))

// eslint-disable-next-line import/first
import { useLukkAuth } from '../src/runtime/composables/useLukkAuth'

function withApp(lukk: Record<string, unknown>, extra: Record<string, unknown> = {}, mode: 'direct' | 'bff' = 'direct') {
  __test.nuxtApp = { $lukk: lukk, ...extra }
  __test.runtimeConfig.public.lukk = { mode, baseURL: 'https://api/auth', confirmationHeader: 'X-Lukk-Confirmation', userEndpoint: '', userKey: '', logoutCookie: '__Host-lukk-logout' }
}

/** A window + document whose listeners the test can see. */
function page() {
  const added: [string, unknown][] = []
  const removed: [string, unknown][] = []
  const target = {
    addEventListener: (name: string, fn: unknown) => { added.push([name, fn]) },
    removeEventListener: (name: string, fn: unknown) => { removed.push([name, fn]) },
  }
  vi.stubGlobal('window', target)
  vi.stubGlobal('document', { ...target, visibilityState: 'visible', cookie: '' })
  return { added, removed }
}

afterEach(() => { __test.reset(); vi.unstubAllGlobals(); vi.restoreAllMocks(); api.mockReset() })

describe('useLukkAuth — what a fresh app starts from', () => {
  it('starts signed out, unresolved, with no challenge and no step-up', () => {
    // Shared keys: whichever composable touches one first sets it, and every one of them rides the SSR
    // payload. A `true` here claims a step-up nobody earned, or a resolved session nobody resolved.
    withApp({})
    useLukkAuth()

    expect(useState(ACCESS_KEY, () => 'x').value).toBeNull()
    expect(useState(CHALLENGE_KEY, () => 'x').value).toBeNull()
    expect(useState(CONFIRMATION_KEY, () => 'x').value).toBeNull()
    expect(useState(CONFIRMED_KEY, () => true).value).toBe(false)
    expect(useState(READY_KEY, () => true).value).toBe(false)
    expect(useState(RESTORE_FAILED_KEY, () => true).value).toBe(false)
  })
})

describe('useLukkAuth — logout paths', () => {
  it('listens for the page leaving while it runs, and stops listening once it is done', async () => {
    const { added, removed } = page()
    withApp({ logout: vi.fn().mockResolvedValue(undefined) })

    await useLukkAuth().logout()

    expect(added.map(([name]) => name)).toEqual(['pagehide', 'visibilitychange'])
    expect(removed).toEqual(added)
    expect(restoreState(__test.nuxtApp).ending).toBeNull()
    expect(restoreState(__test.nuxtApp).handover).toBeNull()
  })

  it('leaves the newer logout as the one in progress when an older one finishes first', async () => {
    let finishFirst!: () => void
    const logout = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => { finishFirst = resolve }))
      .mockImplementationOnce(() => new Promise<void>(() => {}))
    withApp({ logout })
    const auth = useLukkAuth()

    const first = auth.logout()
    await vi.waitFor(() => expect(logout).toHaveBeenCalledOnce())
    void auth.logout()
    const second = restoreState(__test.nuxtApp).ending
    finishFirst()
    await first

    expect(restoreState(__test.nuxtApp).ending).toBe(second)
    expect(second).not.toBeNull()
  })

  it('drops a step-up once logged out', async () => {
    withApp({ logout: vi.fn().mockResolvedValue(undefined) })
    useState(CONFIRMED_KEY, () => true).value = true

    await useLukkAuth().logout()

    expect(useState(CONFIRMED_KEY, () => true).value).toBe(false)
  })

  it('rejects with what the client rejected with, even an error that is not an object', async () => {
    withApp({ logout: vi.fn().mockRejectedValue(null) })
    await expect(useLukkAuth().logout()).rejects.toBeNull()
  })

  it('rejects with the 401 when there is no refresh to renew it with, rather than a TypeError', async () => {
    const unauthenticated = { status: 401 }
    withApp({ logout: vi.fn().mockRejectedValue(unauthenticated) })
    await expect(useLukkAuth().logout()).rejects.toBe(unauthenticated)
  })

  it('notes a direct-mode logout per tab, never as a cookie, even if a logout cookie is configured', async () => {
    // The cookie note is read by the BFF's server; in direct mode there is none, and the tab's own note is
    // what finishes the logout on the next load.
    page()
    const store = new Map<string, string>()
    vi.stubGlobal('sessionStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v) }, removeItem: (k: string) => { store.delete(k) } })
    withApp({ logout: vi.fn(() => new Promise(() => {})) })

    void useLukkAuth().logout()

    expect([...store.keys()]).toEqual(['lukk:logging-out:/'])
    expect((globalThis as { document: { cookie: string } }).document.cookie).toBe('')
  })

  it('sends again in order when the early send on the way out was rejected with nothing', async () => {
    // The early send's failure handler reads `.status` off whatever it got; a bare rejection must count as
    // "not done" and be retried, not throw out of the logout.
    const listeners = new Map<string, () => void>()
    vi.stubGlobal('window', { addEventListener: (n: string, fn: () => void) => { listeners.set(n, fn) }, removeEventListener: () => {} })
    const logout = vi.fn().mockRejectedValueOnce(null).mockResolvedValueOnce(undefined)
    withApp({ logout })
    // A refresh already out holds the logout back, so the page leaves while it is still waiting.
    let settleRefresh!: () => void
    restoreState(__test.nuxtApp).refreshing = new Promise<void>((resolve) => { settleRefresh = resolve })

    const done = useLukkAuth().logout()
    listeners.get('pagehide')!()
    settleRefresh()

    await expect(done).resolves.toBeUndefined()
    expect(logout).toHaveBeenCalledTimes(2)
  })
})

describe('useLukkAuth — user unwrapping switched off', () => {
  it('takes the body as the user verbatim, whatever keys it has', async () => {
    // `user.key: false` reaches here as '', and means "never unwrap" — not "unwrap under some other key".
    withApp({ login: vi.fn().mockResolvedValue({ access_token: 'a', expires_in: 900 }) })
    Object.assign(__test.runtimeConfig.public.lukk, { userEndpoint: 'https://app/me', userKey: '' })
    api.mockResolvedValue({ id: 1, true: { id: 2 } })
    const auth = useLukkAuth()

    await auth.login({ email: 'e', password: 'p' })

    expect(auth.user.value).toEqual({ id: 1, true: { id: 2 } })
  })
})

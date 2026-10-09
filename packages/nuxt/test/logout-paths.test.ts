import { afterEach, describe, expect, it, vi } from 'vitest'
import { ACCESS_KEY, CHALLENGE_KEY, CONFIRMATION_KEY, CONFIRMED_KEY, READY_KEY, RESTORE_FAILED_KEY } from '../src/runtime/keys'
import { restoreState } from '../src/runtime/utils/restore-state'
import { __test, useState } from './mocks/imports'

const { api } = vi.hoisted(() => ({ api: vi.fn() }))
vi.mock('../src/runtime/composables/useLukkFetch', () => ({ useLukkFetch: () => api }))

// eslint-disable-next-line import/first
import { useLukkAuth } from '../src/runtime/composables/useLukkAuth'
// eslint-disable-next-line import/first
import { useLukkPasskeys } from '../src/runtime/composables/useLukkPasskeys'
// eslint-disable-next-line import/first
import { useLukkConfirmation } from '../src/runtime/composables/useLukkConfirmation'

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
    // Two logouts overlap only where the second ends a session a sign-in issued while the first was out
    // (a second `logout()` call now joins the first instead — this test used to make the overlap that way,
    // which is the double-click defect). The guard is the same: the older one finishing must not clear the
    // newer one's hold.
    let finishFirst!: () => void
    let land!: () => void
    const logout = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => { finishFirst = resolve }))
      .mockImplementationOnce(() => new Promise<void>(() => {}))
    const login = vi.fn(() => new Promise((resolve) => { land = () => resolve({ access_token: 'B', expires_in: 900 }) }))
    withApp({ logout, login })
    const auth = useLukkAuth()

    void auth.login({ email: 'e', password: 'p' })
    await vi.waitFor(() => expect(login).toHaveBeenCalledOnce())
    const first = auth.logout()
    await vi.waitFor(() => expect(logout).toHaveBeenCalledOnce())
    land()
    await vi.waitFor(() => expect(logout).toHaveBeenCalledTimes(2))
    const second = restoreState(__test.nuxtApp).ending
    finishFirst()
    await first

    expect(restoreState(__test.nuxtApp).ending).toBe(second)
    expect(second).not.toBeNull()
    // And a `logout()` now joins the newer one rather than starting a third.
    void auth.logout()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(logout).toHaveBeenCalledTimes(2)
  })

  it('ends the session a passkey sign-in issued after a logout went out, with a logout of its own', async () => {
    // A passkey sign-in superseded by a logout called `logout()` for its session — which now JOINS the
    // logout in progress, and that one went out before the session existed. Only one request was sent,
    // and the session the passkey sign-in had just been issued stayed live.
    let finishFirst!: () => void
    let land!: () => void
    const logout = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => { finishFirst = resolve }))
      .mockImplementationOnce(async () => {})
    const loginWithPasskey = vi.fn(() => new Promise((resolve) => { land = () => resolve({ access_token: 'B', expires_in: 900 }) }))
    const passkeyLoginOptions = vi.fn(async () => ({ ceremony_id: 'cer', options: { challenge: 'AA' } }))
    withApp({ logout, loginWithPasskey, passkeyLoginOptions })
    const buffer = new ArrayBuffer(1)
    const assertion = { id: 'credential', type: 'public-key', rawId: buffer, getClientExtensionResults: () => ({}), response: { clientDataJSON: buffer, authenticatorData: buffer, signature: buffer, userHandle: null } }
    vi.stubGlobal('navigator', { credentials: { get: vi.fn(async () => assertion) } })
    const auth = useLukkAuth()

    const signingIn = useLukkPasskeys().login().catch(() => {})
    await vi.waitFor(() => expect(loginWithPasskey).toHaveBeenCalledOnce())
    const first = auth.logout()
    await vi.waitFor(() => expect(logout).toHaveBeenCalledOnce())
    land()
    await vi.waitFor(() => expect(logout).toHaveBeenCalledTimes(2))
    finishFirst()
    await first
    await signingIn
  })

  it('joins a logout already out — a double click ends the session once, and neither call rejects', async () => {
    // The second call ran a logout of its own behind the first: by then the session was gone, so it got a
    // 401 it couldn't renew, rejected — and left the logout note it had just written standing, so the next
    // page load went to finish a logout that was already done.
    page()
    let finish!: () => void
    const logout = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve }))
      .mockRejectedValue({ status: 401 })
    withApp({ logout }, { $lukkRefresh: vi.fn(async () => null) }, 'bff')
    const auth = useLukkAuth()

    const first = auth.logout()
    await vi.waitFor(() => expect(logout).toHaveBeenCalledOnce())
    const second = auth.logout()
    finish()

    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined])
    expect(logout).toHaveBeenCalledOnce()
    // The note went with the logout it was for — the last write clears it.
    expect((globalThis as { document: { cookie: string } }).document.cookie).toMatch(/^__Host-lukk-logout=; .*Max-Age=0/)
    expect(restoreState(__test.nuxtApp).ending).toBeNull()
  })

  it('runs a fresh one once the earlier has finished', async () => {
    const logout = vi.fn().mockResolvedValue(undefined)
    withApp({ logout })
    const auth = useLukkAuth()

    await auth.logout()
    await auth.logout()

    expect(logout).toHaveBeenCalledTimes(2)
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

describe('a step-up still waiting when the session ends', () => {
  it('is cancelled by logout, so a later confirmation does not run the old action', async () => {
    // After a 423 the action waited for `confirmed`. Nothing cancelled it on logout, so the next
    // confirmation — for anything, by anyone signing in on this tab — resolved it and the old action
    // (a passkey deletion, say) ran unasked.
    const logout = vi.fn(async () => {})
    withApp({ logout })
    const auth = useLukkAuth()
    const confirmation = useLukkConfirmation()
    const action = vi.fn().mockRejectedValueOnce({ status: 423 }).mockResolvedValue('done')

    const pending = confirmation.withConfirmation(action)
    await vi.waitFor(() => expect(confirmation.required.value).toBe(true))
    await auth.logout()

    await expect(pending).rejects.toThrow('lukk: confirmation cancelled')
    confirmation.record({ confirmation_token: 'later' })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(action).toHaveBeenCalledOnce()
  })

  it('is cancelled by a sign-in, which may be another account', async () => {
    const login = vi.fn(async () => ({ access_token: 'B', expires_in: 900 }))
    withApp({ login })
    api.mockResolvedValue({ id: 2 })
    const auth = useLukkAuth()
    const confirmation = useLukkConfirmation()
    const action = vi.fn().mockRejectedValueOnce({ status: 423 }).mockResolvedValue('done')

    const pending = confirmation.withConfirmation(action)
    await vi.waitFor(() => expect(confirmation.required.value).toBe(true))
    await auth.login({ email: 'b', password: 'p' })

    await expect(pending).rejects.toThrow('lukk: confirmation cancelled')
    expect(action).toHaveBeenCalledOnce()
  })
})

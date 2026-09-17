import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearPendingLogout, hasPendingLogout, notePendingLogout, noteSignIn, PENDING_LOGOUT_TTL_MS, pendingLogoutAt, signedInSince } from '../src/runtime/utils/pending-logout'

afterEach(() => vi.unstubAllGlobals())

function memoryStorage() {
  const store = new Map<string, string>()
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
  }
}

describe('pending logout note', () => {
  it('notes, reads and clears it in sessionStorage', () => {
    vi.stubGlobal('sessionStorage', memoryStorage())

    expect(hasPendingLogout()).toBe(false)
    notePendingLogout()
    expect(hasPendingLogout()).toBe(true)
    clearPendingLogout()
    expect(hasPendingLogout()).toBe(false)
  })

  it('is honoured only briefly — an old note would end whatever session the tab holds by then', () => {
    vi.stubGlobal('sessionStorage', memoryStorage())
    notePendingLogout(undefined, 1_000)

    expect(hasPendingLogout(undefined, 1_000 + PENDING_LOGOUT_TTL_MS - 1)).toBe(true)
    expect(hasPendingLogout(undefined, 1_000 + PENDING_LOGOUT_TTL_MS)).toBe(false)
  })

  it('is moot once anyone signs in after it — the cookie it would end is that newer session', () => {
    vi.stubGlobal('sessionStorage', memoryStorage())
    vi.stubGlobal('localStorage', memoryStorage())
    notePendingLogout(undefined, 1_000)

    noteSignIn(undefined, 999)
    expect(hasPendingLogout(undefined, 2_000)).toBe(true)
    noteSignIn(undefined, 1_000)
    expect(hasPendingLogout(undefined, 2_000)).toBe(false)
    noteSignIn(undefined, 1_500)
    expect(hasPendingLogout(undefined, 2_000)).toBe(false)
  })

  it('keeps the note when the sign-in record is missing, garbage or unreadable', () => {
    vi.stubGlobal('sessionStorage', memoryStorage())
    notePendingLogout(undefined, 1_000)

    vi.stubGlobal('localStorage', undefined)
    expect(() => noteSignIn(undefined, 1_500)).not.toThrow()
    expect(hasPendingLogout(undefined, 2_000)).toBe(true)

    const garbage = memoryStorage()
    garbage.setItem('lukk:signed-in-at:/', 'soon')
    vi.stubGlobal('localStorage', garbage)
    expect(hasPendingLogout(undefined, 2_000)).toBe(true)

    const refusing = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') } }
    vi.stubGlobal('localStorage', refusing)
    expect(() => noteSignIn(undefined, 1_500)).not.toThrow()
    expect(hasPendingLogout(undefined, 2_000)).toBe(true)

    vi.unstubAllGlobals()
    vi.stubGlobal('sessionStorage', memoryStorage())
    notePendingLogout(undefined, 1_000)
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => { throw new Error('SecurityError') } })
    expect(hasPendingLogout(undefined, 2_000)).toBe(true)
    delete (globalThis as { localStorage?: unknown }).localStorage
  })

  it('reads when the logout still standing was asked for, and whether a sign-in was sent since', () => {
    vi.stubGlobal('sessionStorage', memoryStorage())
    vi.stubGlobal('localStorage', memoryStorage())

    notePendingLogout(undefined, 1_000)
    notePendingLogout(undefined, 1_500) // a new logout: re-stamped
    expect(pendingLogoutAt(undefined, 2_000)).toBe(1_500)

    noteSignIn(undefined, 1_500)
    expect(pendingLogoutAt(undefined, 2_000)).toBeUndefined()
    expect(signedInSince(undefined, 1_500)).toBe(true)
    expect(signedInSince(undefined, 1_501)).toBe(false)
  })

  it('clears up to a time only a note written no later than it', () => {
    vi.stubGlobal('sessionStorage', memoryStorage())
    notePendingLogout(undefined, 1_000)

    clearPendingLogout(undefined, 999)
    expect(hasPendingLogout(undefined, 2_000)).toBe(true)
    clearPendingLogout(undefined, 1_000)
    expect(hasPendingLogout(undefined, 2_000)).toBe(false)
  })

  it('keeps each app on an origin to its own note and sign-in record', () => {
    vi.stubGlobal('sessionStorage', memoryStorage())
    vi.stubGlobal('localStorage', memoryStorage())
    notePendingLogout('/admin/', 1_000)
    notePendingLogout('/shop/', 1_000)

    expect(hasPendingLogout(undefined, 2_000)).toBe(false)
    noteSignIn('/shop/', 1_500)
    expect(hasPendingLogout('/shop/', 2_000)).toBe(false)
    expect(hasPendingLogout('/admin/', 2_000)).toBe(true)
    clearPendingLogout('/admin/')
    expect(hasPendingLogout('/admin/', 2_000)).toBe(false)
  })

  it('ignores a note that isn\'t a timestamp', () => {
    const storage = memoryStorage()
    vi.stubGlobal('sessionStorage', storage)
    for (const value of ['1', 'yes', '']) {
      storage.setItem('lukk:logging-out:/', value)
      expect(hasPendingLogout()).toBe(false) // '1' was the old, undated form — it must not count either
    }
  })

  it('does nothing — and never throws — where storage is missing or refuses', () => {
    vi.stubGlobal('sessionStorage', undefined)
    expect(() => notePendingLogout()).not.toThrow()
    expect(hasPendingLogout()).toBe(false)

    const refusing = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') }, removeItem: () => { throw new Error('denied') } }
    vi.stubGlobal('sessionStorage', refusing)
    expect(() => notePendingLogout()).not.toThrow()
    expect(() => clearPendingLogout()).not.toThrow()
    expect(hasPendingLogout()).toBe(false)

    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, get: () => { throw new Error('SecurityError') } })
    expect(hasPendingLogout()).toBe(false)
    delete (globalThis as { sessionStorage?: unknown }).sessionStorage
  })
})

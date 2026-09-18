import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearPendingLogout, noteSignIn, notePendingLogout, PENDING_LOGOUT_TTL_MS, readPendingLogout, signedInSince } from '../src/runtime/utils/pending-logout'

afterEach(() => vi.unstubAllGlobals())

function memoryStorage() {
  const store = new Map<string, string>()
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
  }
}

describe('pending logout note (direct mode)', () => {
  it('notes the time and the session\'s family, reads it back, and clears it', () => {
    vi.stubGlobal('sessionStorage', memoryStorage())

    expect(readPendingLogout(undefined, 2_000)).toBeUndefined()
    notePendingLogout(undefined, 'fam-1', 1_000)
    expect(readPendingLogout(undefined, 2_000)).toEqual({ at: 1_000, fid: 'fam-1' })
    notePendingLogout(undefined, undefined, 1_500) // a new logout, session unknown
    expect(readPendingLogout(undefined, 2_000)).toEqual({ at: 1_500 })
    clearPendingLogout()
    expect(readPendingLogout(undefined, 2_000)).toBeUndefined()
  })

  it('is honoured only briefly — an old note would end whatever session the tab holds by then', () => {
    vi.stubGlobal('sessionStorage', memoryStorage())
    notePendingLogout(undefined, 'fam-1', 1_000)

    expect(readPendingLogout(undefined, 1_000 + PENDING_LOGOUT_TTL_MS - 1)).toBeDefined()
    expect(readPendingLogout(undefined, 1_000 + PENDING_LOGOUT_TTL_MS)).toBeUndefined()
  })

  it('without a family, is moot once anyone sends a sign-in after it; with one, the session decides instead', () => {
    vi.stubGlobal('sessionStorage', memoryStorage())
    vi.stubGlobal('localStorage', memoryStorage())
    notePendingLogout(undefined, undefined, 1_000)

    noteSignIn(undefined, 999)
    expect(readPendingLogout(undefined, 2_000)).toEqual({ at: 1_000 })
    noteSignIn(undefined, 1_000)
    expect(readPendingLogout(undefined, 2_000)).toBeUndefined()
    expect(signedInSince(undefined, 1_000)).toBe(true)
    expect(signedInSince(undefined, 1_001)).toBe(false)

    notePendingLogout(undefined, 'fam-1', 1_000)
    expect(readPendingLogout(undefined, 2_000)).toEqual({ at: 1_000, fid: 'fam-1' })
  })

  it('keeps a family-less note when the sign-in record is missing, garbage or unreadable', () => {
    vi.stubGlobal('sessionStorage', memoryStorage())
    notePendingLogout(undefined, undefined, 1_000)

    vi.stubGlobal('localStorage', undefined)
    expect(() => noteSignIn(undefined, 1_500)).not.toThrow()
    expect(readPendingLogout(undefined, 2_000)).toEqual({ at: 1_000 })

    const garbage = memoryStorage()
    garbage.setItem('lukk:signed-in-at:/', 'soon')
    vi.stubGlobal('localStorage', garbage)
    expect(readPendingLogout(undefined, 2_000)).toEqual({ at: 1_000 })

    const refusing = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') } }
    vi.stubGlobal('localStorage', refusing)
    expect(() => noteSignIn(undefined, 1_500)).not.toThrow()
    expect(readPendingLogout(undefined, 2_000)).toEqual({ at: 1_000 })

    vi.unstubAllGlobals()
    vi.stubGlobal('sessionStorage', memoryStorage())
    notePendingLogout(undefined, undefined, 1_000)
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => { throw new Error('SecurityError') } })
    expect(readPendingLogout(undefined, 2_000)).toEqual({ at: 1_000 })
    delete (globalThis as { localStorage?: unknown }).localStorage
  })

  it('clears up to a time only a note written no later than it', () => {
    vi.stubGlobal('sessionStorage', memoryStorage())
    notePendingLogout(undefined, 'fam-1', 1_000)

    clearPendingLogout(undefined, 999)
    expect(readPendingLogout(undefined, 2_000)).toBeDefined()
    clearPendingLogout(undefined, 1_000)
    expect(readPendingLogout(undefined, 2_000)).toBeUndefined()
  })

  it('keeps each app on an origin to its own note and sign-in record', () => {
    vi.stubGlobal('sessionStorage', memoryStorage())
    vi.stubGlobal('localStorage', memoryStorage())
    notePendingLogout('/admin/', undefined, 1_000)
    notePendingLogout('/shop/', undefined, 1_000)

    expect(readPendingLogout(undefined, 2_000)).toBeUndefined()
    noteSignIn('/shop/', 1_500)
    expect(readPendingLogout('/shop/', 2_000)).toBeUndefined()
    expect(readPendingLogout('/admin/', 2_000)).toEqual({ at: 1_000 })
    clearPendingLogout('/admin/')
    expect(readPendingLogout('/admin/', 2_000)).toBeUndefined()
  })

  it('ignores a note that isn\'t one', () => {
    const storage = memoryStorage()
    vi.stubGlobal('sessionStorage', storage)
    // '1' and a bare number were earlier forms; a family that isn't a string is dropped, not trusted.
    for (const value of ['1', '1000', 'yes', '', 'null', '{"at":"1000"}', '{"at":0}', '{"at":-5}']) {
      storage.setItem('lukk:logging-out:/', value)
      expect(readPendingLogout(undefined, 2_000)).toBeUndefined()
    }
    storage.setItem('lukk:logging-out:/', '{"at":1000,"fid":7}')
    expect(readPendingLogout(undefined, 2_000)).toEqual({ at: 1_000 })

    storage.setItem('lukk:logging-out:/', 'yes')
    clearPendingLogout(undefined, 5) // unreadable counts as written no later
    expect(storage.getItem('lukk:logging-out:/')).toBeNull()
  })

  it('does nothing — and never throws — where storage is missing or refuses', () => {
    vi.stubGlobal('sessionStorage', undefined)
    expect(() => notePendingLogout()).not.toThrow()
    expect(readPendingLogout()).toBeUndefined()

    const refusing = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') }, removeItem: () => { throw new Error('denied') } }
    vi.stubGlobal('sessionStorage', refusing)
    expect(() => notePendingLogout()).not.toThrow()
    expect(() => clearPendingLogout()).not.toThrow()
    expect(readPendingLogout()).toBeUndefined()

    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, get: () => { throw new Error('SecurityError') } })
    expect(readPendingLogout()).toBeUndefined()
    delete (globalThis as { sessionStorage?: unknown }).sessionStorage
  })
})

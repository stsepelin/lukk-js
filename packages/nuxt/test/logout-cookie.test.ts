import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearLogoutCookie, hasLogoutCookie, logoutNoteAt, setLogoutCookie } from '../src/runtime/utils/logout-cookie'

afterEach(() => vi.unstubAllGlobals())

/** A document whose cookie jar keeps name=value and drops a Max-Age=0 write, like a browser's. */
function fakeDocument() {
  const jar = new Map<string, string>()
  const writes: string[] = []
  const doc = {
    get cookie() { return [...jar].map(([k, v]) => `${k}=${v}`).join('; ') },
    set cookie(line: string) {
      writes.push(line)
      const [pair] = line.split(';')
      const [name, value] = pair!.split('=') as [string, string]
      if (/Max-Age=0\b/.test(line)) jar.delete(name)
      else jar.set(name, value)
    },
  }
  return { doc, writes, jar }
}

describe('BFF logout note cookie (browser side)', () => {
  it('writes a one-minute, same-site note, Secure exactly when the name is __Host-, and clears it the same way', () => {
    const { doc, writes } = fakeDocument()
    vi.stubGlobal('document', doc)

    setLogoutCookie('__Host-lukk-logout', 1_700_000_000_000)
    expect(writes.pop()).toBe('__Host-lukk-logout=1700000000000; Path=/; Max-Age=60; SameSite=Strict; Secure')
    expect(hasLogoutCookie('__Host-lukk-logout')).toBe(true)

    clearLogoutCookie('__Host-lukk-logout')
    expect(writes.pop()).toBe('__Host-lukk-logout=; Path=/; Max-Age=0; SameSite=Strict; Secure')
    expect(hasLogoutCookie('__Host-lukk-logout')).toBe(false)

    setLogoutCookie('lukk-admin-logout', 1_700_000_000_000) // dev over http: no prefix, no Secure
    expect(writes.pop()).toBe('lukk-admin-logout=1700000000000; Path=/; Max-Age=60; SameSite=Strict')
  })

  it('carries the moment the logout was asked for, and reads it back', () => {
    // The page that FINISHES a note needs this: without it, it used its own load time, and a sign-in
    // already on the wire — sent before that load, landing after — could never count as "since".
    const { doc, jar } = fakeDocument()
    vi.stubGlobal('document', doc)

    setLogoutCookie('__Host-lukk-logout', 1_700_000_000_000)
    expect(logoutNoteAt('__Host-lukk-logout', 1_700_000_005_000)).toBe(1_700_000_000_000)
    // The bare `1` a note carried before it held a time: unknown, not 1970 — read as an epoch it would
    // make every sign-in ever count as "since this logout", and no logout would ever be sent again.

    // Renewing carries the ORIGINAL time forward, never this moment: walking it past a sign-in already
    // in flight is exactly what the value exists to prevent.
    setLogoutCookie('__Host-lukk-logout', logoutNoteAt('__Host-lukk-logout')!)
    expect(logoutNoteAt('__Host-lukk-logout')).toBe(1_700_000_000_000)

    // Not written into the future, whatever it is handed.
    setLogoutCookie('lukk-logout', Date.now() + 60 * 60_000)
    expect(logoutNoteAt('lukk-logout')!).toBeLessThanOrEqual(Date.now())

    // A note that predates the timestamp, or one someone rewrote, reads as unknown — the caller then
    // falls back to its own clock, which is what every note did before.
    for (const value of ['1', '', 'soon', '0', '-5', '1.5', String(Date.now() + 60 * 60_000), String(Date.now() + 4_000)]) {
      jar.set('lukk-logout', value)
      expect(logoutNoteAt('lukk-logout'), value).toBeUndefined()
      expect(hasLogoutCookie('lukk-logout'), value).toBe(true) // still a note; only its time is unknown
    }
  })

  it('accepts a note time from the plausibility floor on, and nothing before it', () => {
    // The floor tells a real epoch-ms time from the bare `1` older notes carried; it is inclusive.
    const { doc, jar } = fakeDocument()
    vi.stubGlobal('document', doc)

    jar.set('lukk-logout', '1600000000000')
    expect(logoutNoteAt('lukk-logout')).toBe(1_600_000_000_000)
    jar.set('lukk-logout', '1599999999999')
    expect(logoutNoteAt('lukk-logout')).toBeUndefined()
  })

  it('reads only its own name — not a longer one that starts the same, nor another app\'s', () => {
    const { doc, jar } = fakeDocument()
    vi.stubGlobal('document', doc)
    jar.set('theme', 'dark')
    jar.set('lukk-logout-extra', '1')
    jar.set('__Host-lukk-admin-logout', '1')

    expect(hasLogoutCookie('lukk-logout')).toBe(false)
    expect(hasLogoutCookie('__Host-lukk-logout')).toBe(false)
    jar.set('decoy', 'lukk-logout=1') // the name inside another cookie's value must not count
    expect(hasLogoutCookie('lukk-logout')).toBe(false)
    jar.set('lukk-logout', '1')
    expect(hasLogoutCookie('lukk-logout')).toBe(true)
    jar.set('lukk-signed-out', '1') // the server's answer, read the same way
    expect(hasLogoutCookie('lukk-signed-out')).toBe(true)
  })

  it('does nothing — and never throws — without a document, or where cookies are refused', () => {
    vi.stubGlobal('document', undefined)
    expect(() => setLogoutCookie('lukk-logout')).not.toThrow()
    expect(hasLogoutCookie('lukk-logout')).toBe(false)
    expect(logoutNoteAt('lukk-logout')).toBeUndefined()

    vi.stubGlobal('document', { get cookie(): string { throw new Error('SecurityError') }, set cookie(_: string) { throw new Error('SecurityError') } })
    expect(() => setLogoutCookie('lukk-logout')).not.toThrow()
    expect(() => clearLogoutCookie('lukk-logout')).not.toThrow()
    expect(hasLogoutCookie('lukk-logout')).toBe(false)
    expect(logoutNoteAt('lukk-logout')).toBeUndefined()
  })
})

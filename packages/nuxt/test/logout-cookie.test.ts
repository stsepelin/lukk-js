import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearLogoutCookie, hasLogoutCookie, setLogoutCookie } from '../src/runtime/utils/logout-cookie'

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

    setLogoutCookie('__Host-lukk-logout')
    expect(writes.pop()).toBe('__Host-lukk-logout=1; Path=/; Max-Age=60; SameSite=Strict; Secure')
    expect(hasLogoutCookie('__Host-lukk-logout')).toBe(true)

    clearLogoutCookie('__Host-lukk-logout')
    expect(writes.pop()).toBe('__Host-lukk-logout=; Path=/; Max-Age=0; SameSite=Strict; Secure')
    expect(hasLogoutCookie('__Host-lukk-logout')).toBe(false)

    setLogoutCookie('lukk-admin-logout') // dev over http: no prefix, no Secure
    expect(writes.pop()).toBe('lukk-admin-logout=1; Path=/; Max-Age=60; SameSite=Strict')
  })

  it('reads only its own name — not a longer one that starts the same, nor another app\'s', () => {
    const { doc, jar } = fakeDocument()
    vi.stubGlobal('document', doc)
    jar.set('theme', 'dark')
    jar.set('lukk-logout-extra', '1')
    jar.set('__Host-lukk-admin-logout', '1')

    expect(hasLogoutCookie('lukk-logout')).toBe(false)
    expect(hasLogoutCookie('__Host-lukk-logout')).toBe(false)
    jar.set('lukk-logout', '1')
    expect(hasLogoutCookie('lukk-logout')).toBe(true)
    jar.set('lukk-signed-out', '1') // the server's answer, read the same way
    expect(hasLogoutCookie('lukk-signed-out')).toBe(true)
  })

  it('does nothing — and never throws — without a document, or where cookies are refused', () => {
    vi.stubGlobal('document', undefined)
    expect(() => setLogoutCookie('lukk-logout')).not.toThrow()
    expect(hasLogoutCookie('lukk-logout')).toBe(false)

    vi.stubGlobal('document', { get cookie(): string { throw new Error('SecurityError') }, set cookie(_: string) { throw new Error('SecurityError') } })
    expect(() => setLogoutCookie('lukk-logout')).not.toThrow()
    expect(() => clearLogoutCookie('lukk-logout')).not.toThrow()
    expect(hasLogoutCookie('lukk-logout')).toBe(false)
  })
})

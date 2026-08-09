import { describe, expect, it } from 'vitest'
import { isResolvableBase, isSessionCookieName, LUKK_SESSION_COOKIE, redactCredentials, sessionCookieName } from '../src/runtime/shared'

describe('redactCredentials', () => {
  it('masks userinfo, matching the URL parser at the LAST @ before the path', () => {
    expect(redactCredentials('https://user:hunter2@api.example.com/auth')).toBe('https://***@api.example.com/auth')
    // A `@` inside the password is legal; stopping at the first one would leak the rest of it.
    expect(redactCredentials('https://u:p@ss@api.example.com/auth')).toBe('https://***@api.example.com/auth')
    expect(redactCredentials('https://u:p@ss@api.example.com/auth')).not.toContain('ss@api')
  })

  it('leaves a credential-free base untouched', () => {
    expect(redactCredentials('https://api.example.com/auth')).toBe('https://api.example.com/auth')
    expect(redactCredentials('undefined/auth')).toBe('undefined/auth')
  })
})

describe('isResolvableBase', () => {
  it('accepts an absolute http(s) URL, with or without a path', () => {
    expect(isResolvableBase('https://api.example.com/auth')).toBe(true)
    expect(isResolvableBase('http://localhost:3000')).toBe(true)
  })

  it('rejects the "undefined/..." shape of an unset build-time env var', () => {
    expect(isResolvableBase('undefined/admin/auth')).toBe(false)
  })

  it('rejects a relative path — the server has nothing to resolve it against', () => {
    expect(isResolvableBase('/auth')).toBe(false)
    expect(isResolvableBase('')).toBe(false)
  })

  it('rejects a base missing its scheme, even though `new URL` parses it', () => {
    // `new URL('localhost:3000/auth')` SUCCEEDS — scheme `localhost:`, null origin — so it's the
    // scheme check, not the parse, that catches a base which forgot its `https://`.
    expect(() => new URL('localhost:3000/auth')).not.toThrow()
    expect(isResolvableBase('localhost:3000/auth')).toBe(false)
    expect(isResolvableBase('ftp://files.example.com')).toBe(false)
  })
})

describe('sessionCookieName', () => {
  it('uses the hardened __Host- name when the cookie is Secure', () => {
    expect(sessionCookieName(true)).toBe(LUKK_SESSION_COOKIE)
    expect(LUKK_SESSION_COOKIE).toBe('__Host-lukk-session')
  })

  it('drops the __Host- prefix when Secure is off (dev over http)', () => {
    // __Host- REQUIRES Secure, so a Secure-less cookie must not carry the prefix.
    expect(sessionCookieName(false)).toBe('lukk-session')
  })

  it('inserts a per-app namespace, preserving the __Host- prefix rules', () => {
    expect(sessionCookieName(true, 'admin')).toBe('__Host-lukk-admin-session')
    expect(sessionCookieName(false, 'admin')).toBe('lukk-admin-session')
  })

  it('is unchanged from the default when the namespace is an empty string', () => {
    // An empty string is falsy → no `-<name>` segment, identical to the unnamespaced default.
    expect(sessionCookieName(true, '')).toBe('__Host-lukk-session')
    expect(sessionCookieName(false, '')).toBe('lukk-session')
  })
})

describe('isSessionCookieName', () => {
  it('matches every lukk session cookie name (default + namespaced, Secure + dev)', () => {
    for (const n of ['__Host-lukk-session', 'lukk-session', '__Host-lukk-admin-session', 'lukk-admin-session', 'lukk-a.b_c-session'])
      expect(isSessionCookieName(n)).toBe(true)
  })

  it('does not match a non-lukk or look-alike cookie name', () => {
    for (const n of ['locale', 'lukksession', '__Host-lukk-session-extra', 'session', 'lukk-', 'xlukk-session'])
      expect(isSessionCookieName(n)).toBe(false)
  })
})

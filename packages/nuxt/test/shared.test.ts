import { describe, expect, it } from 'vitest'
import { isSessionCookieName, LUKK_SESSION_COOKIE, sessionCookieName } from '../src/runtime/shared'

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

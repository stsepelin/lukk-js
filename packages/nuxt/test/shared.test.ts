import { describe, expect, it } from 'vitest'
import { LUKK_SESSION_COOKIE, sessionCookieName } from '../src/runtime/shared'

describe('sessionCookieName', () => {
  it('uses the hardened __Host- name when the cookie is Secure', () => {
    expect(sessionCookieName(true)).toBe(LUKK_SESSION_COOKIE)
    expect(LUKK_SESSION_COOKIE).toBe('__Host-lukk-session')
  })

  it('drops the __Host- prefix when Secure is off (dev over http)', () => {
    // __Host- REQUIRES Secure, so a Secure-less cookie must not carry the prefix.
    expect(sessionCookieName(false)).toBe('lukk-session')
  })
})

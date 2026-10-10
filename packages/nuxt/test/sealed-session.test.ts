import { describe, expect, it } from 'vitest'
import { DEFAULT_SESSION_MAX_AGE, sessionCookie, sessionSeal } from '../src/runtime/server/sealed-session'

describe('the lifetime every seal and session cookie is written with', () => {
  it('defaults to lukk\'s refresh_ttl, and takes a valid override as seconds', () => {
    expect(sessionSeal(undefined)).toEqual({ ttl: DEFAULT_SESSION_MAX_AGE * 1000 })
    expect(sessionCookie(true, undefined).maxAge).toBe(DEFAULT_SESSION_MAX_AGE)
    expect(sessionSeal(3600)).toEqual({ ttl: 3_600_000 })
    expect(sessionCookie(true, 3600).maxAge).toBe(3600)
  })

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '3600', 2 ** 60])('refuses to write anything with a maxAge of %o', (maxAge) => {
    // The module rejects these at build; a runtime override (NUXT_LUKK_SESSION_MAX_AGE) lands after it.
    // A ttl of 0 is iron's "never expires" — writing one would undo the lifetime this exists to give.
    expect(() => sessionSeal(maxAge as number)).toThrow(/session\.maxAge/)
    expect(() => sessionCookie(true, maxAge as number)).toThrow(/session\.maxAge/)
  })
})

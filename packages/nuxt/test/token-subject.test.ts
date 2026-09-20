import { describe, expect, it } from 'vitest'
import { tokenSubject } from '../src/runtime/utils/token-subject'

const jwt = (claims: unknown) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`

describe('tokenSubject', () => {
  it('reads a string or numeric sub, including base64url characters that plain base64 lacks', () => {
    expect(tokenSubject(jwt({ sub: 'user-?>~' }))).toBe('user-?>~') // encodes to `-`
    expect(tokenSubject(jwt({ sub: '??' }))).toBe('??') // encodes to `_` — common in real tokens (`iss` URLs)
    expect(tokenSubject(jwt({ sub: 42 }))).toBe('42')
  })

  it('is undefined for anything that does not name a subject', () => {
    for (const value of [undefined, null, 42, '', 'not-a-jwt', 'h..s', 'h.%%%.s', jwt({}), jwt({ sub: null }), jwt({ sub: { id: 1 } })])
      expect(tokenSubject(value)).toBeUndefined()
  })
})

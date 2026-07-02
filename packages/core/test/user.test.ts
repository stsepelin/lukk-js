import { describe, expect, it } from 'vitest'
import { isEmailVerified, shapeUser, userShapeWarning } from '../src/user'

describe('shapeUser', () => {
  it('auto-unwraps a clean Laravel `{ data: {...} }` wrapper', () => {
    expect(shapeUser({ data: { id: 1, name: 'Ada' } })).toEqual({ id: 1, name: 'Ada' })
  })

  it('leaves a bare (unwrapped) user untouched', () => {
    expect(shapeUser({ id: 1, name: 'Ada' })).toEqual({ id: 1, name: 'Ada' })
  })

  it('returns null for `{ data: null }` (a "no user" response)', () => {
    expect(shapeUser({ data: null })).toBeNull()
  })

  it('does NOT unwrap a paginated/collection envelope (data + meta/links)', () => {
    const paged = { data: { id: 1 }, meta: { total: 1 }, links: {} }
    expect(shapeUser(paged)).toBe(paged) // kept as-is, not unwrapped
  })

  it('returns null for an error envelope (never a user), with or without data', () => {
    expect(shapeUser({ errors: { email: ['x'] } })).toBeNull()
    expect(shapeUser({ data: { id: 1 }, errors: {} })).toBeNull()
  })

  it('does NOT unwrap when `data` is an array (a collection)', () => {
    const body = { data: [{ id: 1 }] }
    expect(shapeUser(body)).toBe(body)
  })

  it('keeps a non-object `data` value as-is (not a single-resource wrapper)', () => {
    expect(shapeUser({ data: 5 })).toEqual({ data: 5 })
  })

  it('returns null for a non-object body', () => {
    expect(shapeUser(null)).toBeNull()
    expect(shapeUser('nope')).toBeNull()
    expect(shapeUser([{ id: 1 }])).toBeNull()
  })

  it('unwraps a custom key when configured', () => {
    expect(shapeUser({ result: { id: 2 } }, 'result')).toEqual({ id: 2 })
  })

  it('disables unwrapping with key=false (keeps the wrapper)', () => {
    const wrapped = { data: { id: 1 } }
    expect(shapeUser(wrapped, false)).toBe(wrapped)
  })
})

describe('isEmailVerified', () => {
  it('is false for a null user', () => expect(isEmailVerified(null)).toBe(false))
  it('accepts the OIDC boolean `email_verified: true`', () =>
    expect(isEmailVerified({ email_verified: true })).toBe(true))
  it('is false for `email_verified: false`', () =>
    expect(isEmailVerified({ email_verified: false })).toBe(false))
  it('accepts a non-null Laravel `email_verified_at` timestamp', () =>
    expect(isEmailVerified({ email_verified_at: '2026-07-01T00:00:00Z' })).toBe(true))
  it('is false for `email_verified_at: null`', () =>
    expect(isEmailVerified({ email_verified_at: null })).toBe(false))
  it('is false when neither field is present', () => expect(isEmailVerified({ id: 1 })).toBe(false))
})

describe('userShapeWarning', () => {
  it('returns null for a well-shaped user (has id)', () =>
    expect(userShapeWarning({ id: 1 })).toBeNull())
  it('returns null for a non-object', () => expect(userShapeWarning(null)).toBeNull())
  it('returns null for a bare object with no id and no wrapper markers', () =>
    expect(userShapeWarning({ email: 'a@b.c' } as never)).toBeNull())
  it('warns when a no-id user still looks like a `data` wrapper', () =>
    expect(userShapeWarning({ data: { name: 'Ada' } } as never)).toContain('user.endpoint'))
  it('warns when a no-id user carries a pagination envelope', () =>
    expect(userShapeWarning({ meta: {}, links: {} } as never)).toContain('auto-unwraps'))
})

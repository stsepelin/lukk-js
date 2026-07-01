import { afterEach, describe, expect, it, vi } from 'vitest'
import { __test } from './mocks/imports'

const auth = { loggedIn: { value: false } }
vi.mock('../src/runtime/composables/useLukkAuth', () => ({ useLukkAuth: () => auth }))
const emailVer = { verified: { value: false } }
vi.mock('../src/runtime/composables/useLukkEmailVerification', () => ({ useLukkEmailVerification: () => emailVer }))
const confirm = { confirmed: { value: false } }
vi.mock('../src/runtime/composables/useLukkConfirmation', () => ({ useLukkConfirmation: () => confirm }))

// eslint-disable-next-line import/first
import middleware from '../src/runtime/middleware/auth'
// eslint-disable-next-line import/first
import guest from '../src/runtime/middleware/guest'
// eslint-disable-next-line import/first
import verified from '../src/runtime/middleware/verified'
// eslint-disable-next-line import/first
import confirmed from '../src/runtime/middleware/confirmed'

afterEach(() => { __test.reset(); auth.loggedIn.value = false; emailVer.verified.value = false; confirm.confirmed.value = false })

const run = (path: string) => (middleware as unknown as (to: { path: string }) => unknown)({ path })
const runGuest = (path: string) => (guest as unknown as (to: { path: string }) => unknown)({ path })
const runVerified = (path: string) => (verified as unknown as (to: { path: string }) => unknown)({ path })
const runConfirmed = (path: string) => (confirmed as unknown as (to: { path: string }) => unknown)({ path })

describe('lukk-auth middleware', () => {
  it('redirects to /login when logged out', () => {
    auth.loggedIn.value = false
    run('/dashboard')
    expect(__test.navigated).toBe('/login')
  })

  it('allows the request when logged in', () => {
    auth.loggedIn.value = true
    expect(run('/dashboard')).toBeUndefined()
    expect(__test.navigated).toBeUndefined()
  })

  it('does not redirect on the login page itself', () => {
    auth.loggedIn.value = false
    expect(run('/login')).toBeUndefined()
    expect(__test.navigated).toBeUndefined()
  })
})

describe('lukk-guest middleware', () => {
  it('bounces an authenticated user to /', () => {
    auth.loggedIn.value = true
    runGuest('/login')
    expect(__test.navigated).toBe('/')
  })

  it('lets a guest through', () => {
    auth.loggedIn.value = false
    expect(runGuest('/login')).toBeUndefined()
    expect(__test.navigated).toBeUndefined()
  })

  it('does not bounce when already on /', () => {
    auth.loggedIn.value = true
    expect(runGuest('/')).toBeUndefined()
    expect(__test.navigated).toBeUndefined()
  })
})

describe('lukk-verified middleware', () => {
  it('redirects an unverified logged-in user to /verify-email', () => {
    auth.loggedIn.value = true
    runVerified('/dashboard')
    expect(__test.navigated).toBe('/verify-email')
  })

  it('lets a verified user through', () => {
    auth.loggedIn.value = true
    emailVer.verified.value = true
    expect(runVerified('/dashboard')).toBeUndefined()
    expect(__test.navigated).toBeUndefined()
  })

  it('ignores a logged-out user (lukk-auth handles login)', () => {
    auth.loggedIn.value = false
    expect(runVerified('/dashboard')).toBeUndefined()
    expect(__test.navigated).toBeUndefined()
  })

  it('does not redirect on the verify page itself', () => {
    auth.loggedIn.value = true
    expect(runVerified('/verify-email')).toBeUndefined()
    expect(__test.navigated).toBeUndefined()
  })
})

describe('lukk-confirmed middleware', () => {
  it('redirects an unconfirmed logged-in user to /confirm-password', () => {
    auth.loggedIn.value = true
    runConfirmed('/settings/security')
    expect(__test.navigated).toBe('/confirm-password')
  })

  it('lets a confirmed user through', () => {
    auth.loggedIn.value = true
    confirm.confirmed.value = true
    expect(runConfirmed('/settings/security')).toBeUndefined()
    expect(__test.navigated).toBeUndefined()
  })

  it('ignores a logged-out user', () => {
    auth.loggedIn.value = false
    expect(runConfirmed('/settings/security')).toBeUndefined()
    expect(__test.navigated).toBeUndefined()
  })

  it('does not redirect on the confirm page itself', () => {
    auth.loggedIn.value = true
    expect(runConfirmed('/confirm-password')).toBeUndefined()
    expect(__test.navigated).toBeUndefined()
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { __test } from './mocks/imports'

const auth = { loggedIn: { value: false } }
vi.mock('../src/runtime/composables/useLukkAuth', () => ({ useLukkAuth: () => auth }))

// eslint-disable-next-line import/first
import middleware from '../src/runtime/middleware/auth'
// eslint-disable-next-line import/first
import guest from '../src/runtime/middleware/guest'

afterEach(() => { __test.reset() })

const run = (path: string) => (middleware as unknown as (to: { path: string }) => unknown)({ path })
const runGuest = (path: string) => (guest as unknown as (to: { path: string }) => unknown)({ path })

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

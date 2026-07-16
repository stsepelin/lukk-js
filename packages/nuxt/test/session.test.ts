import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __test } from './mocks/imports'

// Pure read of the request cookie + a pure unseal — no Set-Cookie side effects.
vi.mock('h3', () => ({
  getCookie: (event: { cookies?: Record<string, string> }, name: string) => event.cookies?.[name],
  unsealSession: async (_event: unknown, _config: unknown, sealed: string) => {
    if (sealed === 'TAMPERED') throw new Error('bad seal')
    return { id: 'x', createdAt: 0, data: JSON.parse(sealed) }
  },
}))

// eslint-disable-next-line import/first
import { getLukkAccessToken, useLukkSession } from '../src/runtime/server/utils/session'

function event(sealed?: string) {
  return { cookies: sealed === undefined ? {} : { '__Host-lukk-session': sealed } }
}

beforeEach(() => { __test.runtimeConfig.lukk = { sessionPassword: 'p'.repeat(32) } as unknown as Record<string, unknown> })
afterEach(() => __test.reset())

describe('getLukkAccessToken / useLukkSession', () => {
  it('returns the access token from a valid sealed session', async () => {
    const e = event(JSON.stringify({ access: 'tok', refresh: 'r' }))
    expect(await getLukkAccessToken(e)).toBe('tok')
    expect(await useLukkSession(e)).toEqual({ access: 'tok' })
  })

  it('reads exactly the app\'s resolved cookie name (relaxed + namespaced), ignoring another app\'s', async () => {
    // Name derived from cookieSecure (false → relaxed) + the namespace: `lukk-admin-session`.
    __test.runtimeConfig.lukk = { sessionPassword: 'p'.repeat(32), cookieSecure: false, cookieNamespace: 'admin' } as unknown as Record<string, unknown>
    expect(await getLukkAccessToken({ cookies: { 'lukk-admin-session': JSON.stringify({ access: 'devtok' }) } })).toBe('devtok')
    // A co-hosted app's default-named cookie is not read — no cross-app session bleed.
    expect(await getLukkAccessToken({ cookies: { '__Host-lukk-session': JSON.stringify({ access: 'other' }) } })).toBeNull()
  })

  it('returns null when there is no session cookie (unauthenticated)', async () => {
    expect(await getLukkAccessToken(event())).toBeNull()
  })

  it('returns null when the seal is tampered or expired', async () => {
    expect(await getLukkAccessToken(event('TAMPERED'))).toBeNull()
  })

  it('returns null when no session password is configured', async () => {
    __test.runtimeConfig.lukk = {} as unknown as Record<string, unknown>
    expect(await getLukkAccessToken(event(JSON.stringify({ access: 'tok' })))).toBeNull()
  })

  it('returns null when the session carries no access token', async () => {
    expect(await getLukkAccessToken(event(JSON.stringify({ refresh: 'r' })))).toBeNull()
  })
})

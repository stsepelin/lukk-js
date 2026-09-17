import { afterEach, describe, expect, it, vi } from 'vitest'
import { ENDED_SESSION_LIMIT, ENDED_SESSION_TTL_MS, endedSessionCount, forgetEndedSessions, isSessionEnded, markSessionEnded, newSessionId, sessionKey } from '../src/runtime/server/ended-sessions'

afterEach(() => { forgetEndedSessions(); vi.restoreAllMocks() })

describe('ended sessions', () => {
  it('remembers an ended session for the TTL, then forgets it', () => {
    markSessionEnded('a', 1_000)

    expect(isSessionEnded('a', 1_000)).toBe(true)
    expect(isSessionEnded('a', 1_000 + ENDED_SESSION_TTL_MS - 1)).toBe(true)
    expect(isSessionEnded('a', 1_000 + ENDED_SESSION_TTL_MS)).toBe(false)
    expect(isSessionEnded('b', 1_000)).toBe(false)
  })

  it('ignores a session with no identity, rather than keying every such session together', () => {
    markSessionEnded(undefined)

    expect(isSessionEnded(undefined)).toBe(false)
    expect(isSessionEnded('')).toBe(false)
  })

  it('drops expired entries as new ones arrive, and re-marking extends an entry', () => {
    markSessionEnded('old', 0)
    markSessionEnded('kept', ENDED_SESSION_TTL_MS / 2)
    markSessionEnded('old', ENDED_SESSION_TTL_MS / 2) // re-marked: moves to the end with a fresh expiry

    markSessionEnded('new', ENDED_SESSION_TTL_MS + 1)

    expect(isSessionEnded('old', ENDED_SESSION_TTL_MS + 1)).toBe(true)
    expect(isSessionEnded('kept', ENDED_SESSION_TTL_MS + 1)).toBe(true)
  })

  it('actually removes expired entries, not just reports them as expired — and does not warn about those', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    markSessionEnded('a', 0)
    markSessionEnded('b', 1)

    markSessionEnded('c', ENDED_SESSION_TTL_MS + 0.5) // a has expired, b has not

    expect(endedSessionCount()).toBe(2)
    expect(warn).not.toHaveBeenCalled() // only evicting a LIVE entry loses protection
  })

  it('keeps expiry order when an entry is re-marked, so an expired one behind it is still pruned', () => {
    markSessionEnded('a', 0)
    markSessionEnded('b', 1)
    markSessionEnded('a', 2) // must move behind b; left in place, a would stop the prune before b

    markSessionEnded('c', ENDED_SESSION_TTL_MS + 1.5) // b expired, a not

    expect(endedSessionCount()).toBe(2)
    expect(isSessionEnded('a', ENDED_SESSION_TTL_MS + 1.5)).toBe(true)
  })

  it('stays bounded whatever the sign-in rate, dropping the oldest first — and says so, once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (let i = 0; i <= ENDED_SESSION_LIMIT + 1; i++) markSessionEnded(`s${i}`, 0)
    expect(warn).toHaveBeenCalledOnce()
    expect(String(warn.mock.calls[0]![0])).toContain('no longer guarded')

    expect(isSessionEnded('s0', 0)).toBe(false)
    expect(isSessionEnded('s1', 0)).toBe(false)
    expect(isSessionEnded('s2', 0)).toBe(true)
    expect(isSessionEnded(`s${ENDED_SESSION_LIMIT + 1}`, 0)).toBe(true)
  })

  it('keys a session by its own sid, falling back to h3\'s id for one sealed before sid existed', () => {
    expect(sessionKey({ id: 'h3', data: { sid: 'mine' } })).toBe('mine')
    expect(sessionKey({ id: 'h3', data: {} })).toBe('h3')
    expect(sessionKey({ data: {} })).toBeUndefined()
  })

  it('mints unguessable, distinct session ids', () => {
    const a = newSessionId()
    expect(a).toMatch(/^[0-9a-f-]{36}$/)
    expect(newSessionId()).not.toBe(a)
  })
})

describe('ended sessions across bundles', () => {
  it('shares one record between separately bundled copies of the module', async () => {
    // Nitro's handlers and the Nuxt app's server bundle each get their own copy. A module-level Map let
    // SSR hydration check a record that the proxies' sign-ins and logouts never wrote to.
    const { vi } = await import('vitest')
    vi.resetModules()
    const copy = await import('../src/runtime/server/ended-sessions')

    markSessionEnded('from-the-proxy-bundle')

    expect(copy.isSessionEnded('from-the-proxy-bundle')).toBe(true)
  })
})

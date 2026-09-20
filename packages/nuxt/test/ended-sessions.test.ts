import { afterEach, describe, expect, it, vi } from 'vitest'
import { ENDED_SESSION_LIMIT, ENDED_SESSION_TTL_MS, endedSessionCount, forgetEndedSessions, isSessionEnded, markSessionEnded, newSessionId, SHARED_STORE_TIMEOUT_MS, sessionEnded as sessionEndedHere, sessionKey, sessionReplaced, useSharedEndedSessions, withholdSessionCookie } from '../src/runtime/server/ended-sessions'

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

    expect(endedSessionCount()).toBe(0) // not stored under an `undefined` key, taking a slot
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

  it('prunes an entry the moment it expires, silently — it no longer guards anything', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    markSessionEnded('a', 0)

    markSessionEnded('b', ENDED_SESSION_TTL_MS) // exactly when `a` stops counting

    expect(endedSessionCount()).toBe(1)
    expect(warn).not.toHaveBeenCalled()
  })

  it('names the window in minutes when it gives up on the oldest', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (let i = 0; i <= ENDED_SESSION_LIMIT; i++) markSessionEnded(`s${i}`, 0)
    expect(String(warn.mock.calls[0]![0])).toContain(`within ${ENDED_SESSION_TTL_MS / 60_000} minutes`)
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
  it('shares its outage flags too, so one outage is reported once and backed off everywhere', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.resetModules()
    const copy = await import('../src/runtime/server/ended-sessions')
    const failing = { mark: async () => { throw new Error('down') }, has: async () => { throw new Error('down') } }
    copy.useSharedEndedSessions(failing)

    await copy.sessionEnded('a')
    await sessionEndedHere('b')

    expect(error).toHaveBeenCalledOnce()
    copy.useSharedEndedSessions(undefined)
  })

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

describe('withholdSessionCookie', () => {
  const response = (queued: unknown) => {
    const headers = new Map<string, unknown>([['set-cookie', queued]])
    return {
      headers,
      res: {
        getHeader: (k: string) => headers.get(k),
        setHeader: (k: string, v: string[]) => { headers.set(k, v) },
        removeHeader: (k: string) => { headers.delete(k) },
      },
    }
  }

  it('keeps the other cookie when a lone one is queued as a plain string', () => {
    // Node queues a single `Set-Cookie` as a string, not an array; read as nothing, the app's own
    // cookie was dropped along with ours.
    const { headers, res } = response('theme=dark; Path=/')
    withholdSessionCookie(res, '__Host-lukk-session')
    expect(headers.get('set-cookie')).toEqual(['theme=dark; Path=/'])
  })
})

describe('the shared store, bounded', () => {
  afterEach(() => { useSharedEndedSessions(undefined); vi.useRealTimers() })

  it('never asks the store whether a session with no identity was replaced', async () => {
    const store = { mark: vi.fn(async () => {}), has: vi.fn(async () => true) }
    useSharedEndedSessions(store)

    expect(await sessionReplaced(undefined)).toBe(false)
    expect(store.has).not.toHaveBeenCalled()
  })

  it('disarms its timeout once the store answers, or fails', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => {})

    useSharedEndedSessions({ mark: async () => {}, has: async () => false })
    await sessionEndedHere('a')
    expect(vi.getTimerCount()).toBe(0)

    useSharedEndedSessions({ mark: async () => {}, has: async () => { throw new Error('down') } })
    await sessionEndedHere('b')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('says how long it waited when the store never answers', async () => {
    vi.useFakeTimers()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    useSharedEndedSessions({ mark: () => new Promise(() => {}), has: () => new Promise(() => {}) })

    const answer = sessionEndedHere('a')
    await vi.advanceTimersByTimeAsync(SHARED_STORE_TIMEOUT_MS)
    await answer

    expect(String(error.mock.calls[0]![1])).toContain(`no answer within ${SHARED_STORE_TIMEOUT_MS}ms`)
  })
})

describe('a fresh process', () => {
  it('reports its first store outage and warns on its first saturation', async () => {
    const shared = globalThis as { __lukkEndedSessionFlags?: unknown, __lukkEndedSessions?: unknown }
    const [flags, record] = [shared.__lukkEndedSessionFlags, shared.__lukkEndedSessions]
    delete shared.__lukkEndedSessionFlags
    delete shared.__lukkEndedSessions
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      vi.resetModules()
      const fresh = await import('../src/runtime/server/ended-sessions')
      fresh.useSharedEndedSessions({ mark: async () => { throw new Error('down') }, has: async () => { throw new Error('down') } })
      await fresh.sessionEnded('a')
      fresh.useSharedEndedSessions(undefined)
      for (let i = 0; i <= fresh.ENDED_SESSION_LIMIT; i++) fresh.markSessionEnded(`s${i}`, 0)

      expect(error).toHaveBeenCalledOnce()
      expect(warn).toHaveBeenCalledOnce()
    }
    finally {
      shared.__lukkEndedSessionFlags = flags
      shared.__lukkEndedSessions = record
    }
  })
})

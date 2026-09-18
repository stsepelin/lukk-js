import { afterEach, describe, expect, it, vi } from 'vitest'
import { __test, useStorage } from './mocks/imports'
import { endSession, ENDED_SESSION_TTL_MS, forgetEndedSessions, sessionEnded, sessionReplaced, SHARED_STORE_BACKOFF_MS, SHARED_STORE_TIMEOUT_MS, useSharedEndedSessions } from '../src/runtime/server/ended-sessions'
import plugin from '../src/runtime/server/plugins/shared-ended-sessions'

const runPlugin = () => (plugin as unknown as () => void)()

afterEach(() => {
  __test.reset()
  forgetEndedSessions()
  useSharedEndedSessions(undefined)
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('the shared replaced-session store', () => {
  it('is left out unless session.sharedStore names a mount', async () => {
    ;(__test.runtimeConfig as Record<string, unknown>).lukk = { sharedStore: '' }
    runPlugin()

    await endSession('a')
    forgetEndedSessions() // another instance: nothing in its process
    expect(await sessionEnded('a')).toBe(false)
  })

  it('lets another instance see a session this one ended', async () => {
    ;(__test.runtimeConfig as Record<string, unknown>).lukk = { sharedStore: 'lukk-sessions' }
    __test.storageMounts.add('lukk-sessions')
    runPlugin()

    await endSession('replaced')
    forgetEndedSessions() // the process-local record is gone — as on another instance
    expect(await sessionEnded('replaced')).toBe(true)
    expect(await sessionEnded('someone-else')).toBe(false)
  })

  it('stores its own expiry, so a driver without TTL still stops answering after it', async () => {
    vi.useFakeTimers()
    ;(__test.runtimeConfig as Record<string, unknown>).lukk = { sharedStore: 'no-ttl' }
    __test.storageMounts.add('no-ttl')
    runPlugin()

    await endSession('replaced')
    forgetEndedSessions()
    expect(await useStorage('no-ttl').getItem('ended:replaced')).toBe(Date.now() + ENDED_SESSION_TTL_MS)

    vi.advanceTimersByTime(ENDED_SESSION_TTL_MS)
    expect(await sessionEnded('replaced')).toBe(false)
  })

  it('passes the TTL to drivers that expire keys themselves', async () => {
    const setItem = vi.fn(async () => {})
    useSharedEndedSessions(undefined)
    ;(__test.runtimeConfig as Record<string, unknown>).lukk = { sharedStore: 'redis' }
    __test.storageMounts.add('redis')
    const storage = useStorage('redis') as unknown as { setItem: typeof setItem }
    storage.setItem = setItem
    const mocks = await import('./mocks/imports')
    vi.spyOn(mocks, 'useStorage').mockReturnValue(storage as never)
    runPlugin()

    await endSession('replaced')

    expect(setItem).toHaveBeenCalledWith('ended:replaced', expect.any(Number), { ttl: ENDED_SESSION_TTL_MS / 1000 })
  })

  it('tells another instance a session was REPLACED by a sign-in, not merely ended', async () => {
    // A late logout must not clear the cookie of the session that replaced it — but should clear one a
    // logout ended.
    ;(__test.runtimeConfig as Record<string, unknown>).lukk = { sharedStore: 'lukk-sessions' }
    __test.storageMounts.add('lukk-sessions')
    runPlugin()

    await endSession('replaced', { replaced: true })
    await endSession('logged-out')
    forgetEndedSessions()

    expect(await sessionReplaced('replaced')).toBe(true)
    expect(await sessionReplaced('logged-out')).toBe(false)
    expect(await sessionEnded('logged-out')).toBe(true)
    expect(await sessionReplaced(undefined)).toBe(false)
  })

  it('warns at startup when the named mount does not exist — it would silently be per process', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    ;(__test.runtimeConfig as Record<string, unknown>).lukk = { sharedStore: 'lukk-sesions' }

    runPlugin()
    expect(warn).toHaveBeenCalledOnce()
    expect(String(warn.mock.calls[0]![0])).toContain('lukk-sesions')

    warn.mockClear()
    __test.storageMounts.add('lukk-sessions')
    ;(__test.runtimeConfig as Record<string, unknown>).lukk = { sharedStore: 'lukk-sessions' }
    runPlugin()
    expect(warn).not.toHaveBeenCalled()
  })

  it('does not hold a request up for a store that doesn\'t answer, and leaves it alone for a while', async () => {
    // A Redis client retrying a dead host took over ten seconds to give up — on every sign-in, logout,
    // refresh, and three times per signed-in page.
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const has = vi.fn(() => new Promise<boolean>(() => {}))
    useSharedEndedSessions({ mark: () => new Promise(() => {}), has })

    const answer = sessionEnded('a')
    await vi.advanceTimersByTimeAsync(SHARED_STORE_TIMEOUT_MS)
    expect(await answer).toBe(false)

    // Backing off: the store isn't asked again straight away, so the next check is immediate.
    expect(await sessionEnded('b')).toBe(false)
    const marking = endSession('c')
    await vi.advanceTimersByTimeAsync(0)
    await marking
    expect(has).toHaveBeenCalledOnce()

    vi.advanceTimersByTime(SHARED_STORE_BACKOFF_MS)
    void sessionEnded('d')
    await vi.advanceTimersByTimeAsync(0)
    expect(has).toHaveBeenCalledTimes(2)
  })

  it('reports a store that keeps failing only once', async () => {
    vi.useFakeTimers()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    useSharedEndedSessions({ mark: async () => { throw new Error('down') }, has: async () => { throw new Error('down') } })

    expect(await sessionEnded('a')).toBe(false)
    vi.advanceTimersByTime(SHARED_STORE_BACKOFF_MS)
    expect(await sessionEnded('b')).toBe(false)

    expect(error).toHaveBeenCalledOnce()
  })

  it('checks the process first, and never asks the store about a session with no identity', async () => {
    const store = { mark: vi.fn(async () => {}), has: vi.fn(async () => false) }
    useSharedEndedSessions(store)

    await endSession('local')
    expect(await sessionEnded('local')).toBe(true)
    expect(store.has).not.toHaveBeenCalled()

    await endSession(undefined)
    expect(await sessionEnded(undefined)).toBe(false)
    expect(store.mark).toHaveBeenCalledOnce() // only for 'local'
    expect(store.has).not.toHaveBeenCalled()
  })

  it('degrades to the process-local record when the store fails — reported once, never a failed request', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    useSharedEndedSessions({ mark: async () => { throw new Error('down') }, has: async () => { throw new Error('down') } })

    await expect(endSession('a')).resolves.toBeUndefined()
    expect(await sessionEnded('a')).toBe(true) // still recorded in-process
    expect(await sessionEnded('b')).toBe(false)

    expect(error).toHaveBeenCalledOnce()
    expect(String(error.mock.calls[0]![0])).toContain('session.sharedStore')
  })

  it('reports a LATER outage too, once the store has answered in between', async () => {
    // "Reported once" is per outage, not per process. The flag was cleared only by the test seam, so a
    // store that failed, recovered, and failed again weeks later said nothing at all — and this is the
    // one message telling an operator that replaced sessions are guarded per process again.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    let healthy = false
    useSharedEndedSessions({
      mark: async () => { if (!healthy) throw new Error('down') },
      has: async () => { if (!healthy) throw new Error('down'); return false },
    })

    await endSession('a')
    expect(error).toHaveBeenCalledOnce()

    // Fake timers for the rest: `useRealTimers` would put `Date.now()` back where it started and undo
    // the backoff this needs to step over.
    vi.useFakeTimers()

    // Recovered: the backoff elapses, the store answers, and the report is armed again.
    healthy = true
    await vi.advanceTimersByTimeAsync(SHARED_STORE_BACKOFF_MS + 1)
    await endSession('b')
    expect(error).toHaveBeenCalledOnce() // nothing new to say while it works

    healthy = false
    await vi.advanceTimersByTimeAsync(SHARED_STORE_BACKOFF_MS + 1)
    await endSession('c')

    expect(error).toHaveBeenCalledTimes(2)
  })
})

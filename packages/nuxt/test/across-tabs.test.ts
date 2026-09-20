import { afterEach, describe, expect, it, vi } from 'vitest'
import { acrossTabs, beginSession, REFRESH_SETTLE_TIMEOUT, restoreState, settle, signIn, TAB_LOCK_WAIT_MS } from '../src/runtime/utils/restore-state'

/** A LockManager with the one behaviour that matters: an exclusive lock, queued, abortable while waiting. */
function fakeLocks() {
  const queue: Array<{ grant: () => void }> = []
  let held = false
  const grantNext = () => {
    const next = queue.shift()
    if (next) next.grant()
  }
  return {
    requests: 0,
    request(name: string, options: { signal?: AbortSignal }, callback: () => Promise<void>) {
      this.requests++
      return new Promise<void>((resolve, reject) => {
        const entry = {
          grant: () => {
            held = true
            callback().then(() => { held = false; resolve(); grantNext() })
          },
        }
        options.signal?.addEventListener('abort', () => {
          const index = queue.indexOf(entry)
          if (index !== -1) { queue.splice(index, 1); reject(new DOMException('aborted', 'AbortError')) }
        })
        if (held) queue.push(entry)
        else entry.grant()
      })
    },
  }
}

const tab = () => {
  const app = {}
  restoreState(app).lockName = 'lukk:session:/'
  return app
}
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((r) => { resolve = r })
  return { promise, resolve }
}
const macrotask = () => new Promise(resolve => setTimeout(resolve, 0))

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('acrossTabs', () => {
  it('queues one tab\'s operation behind another tab\'s', async () => {
    vi.stubGlobal('navigator', { locks: fakeLocks() })
    const [one, two] = [tab(), tab()]
    const signIn = deferred()
    const order: string[] = []

    const signingIn = acrossTabs(one, async () => { order.push('sign-in starts'); await signIn.promise; order.push('sign-in ends') })
    await macrotask()
    const refreshing = acrossTabs(two, async () => { order.push('refresh') })
    await macrotask()
    expect(order).toEqual(['sign-in starts'])

    signIn.resolve()
    await Promise.all([signingIn, refreshing])
    expect(order).toEqual(['sign-in starts', 'sign-in ends', 'refresh'])
  })

  it('shares the lock within a tab, so an operation nested inside another does not wait on itself', async () => {
    // A logout renewing its token runs a refresh inside the logout.
    const locks = fakeLocks()
    vi.stubGlobal('navigator', { locks })
    const app = tab()

    const result = await acrossTabs(app, () => acrossTabs(app, async () => 'renewed'))

    expect(result).toBe('renewed')
    expect(locks.requests).toBe(1)
    expect(restoreState(app).lockUsers).toBe(0)
  })

  it('keeps holding it while any operation in the tab still runs, then releases it', async () => {
    vi.stubGlobal('navigator', { locks: fakeLocks() })
    const [one, two] = [tab(), tab()]
    const first = deferred()
    const second = deferred()
    const order: string[] = []

    const a = acrossTabs(one, async () => { await first.promise; order.push('one:a') })
    await macrotask()
    const b = acrossTabs(one, async () => { await second.promise; order.push('one:b') })
    const other = acrossTabs(two, async () => { order.push('two') })
    first.resolve()
    await a
    await macrotask()
    expect(order).toEqual(['one:a']) // the other tab still waits: this tab's second operation holds it

    second.resolve()
    await Promise.all([b, other])
    expect(order).toEqual(['one:a', 'one:b', 'two'])
  })

  it('goes ahead without the lock when another tab holds it past the cap', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('navigator', { locks: fakeLocks() })
    const [stuck, waiting] = [tab(), tab()]

    void acrossTabs(stuck, () => new Promise(() => {}))
    await vi.advanceTimersByTimeAsync(0)
    let ran = false
    const operation = acrossTabs(waiting, async () => { ran = true })
    await vi.advanceTimersByTimeAsync(TAB_LOCK_WAIT_MS - 1)
    expect(ran).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    await operation
    expect(ran).toBe(true)
  })

  it('gives the lock back after the settle cap even while its operation is still running', async () => {
    // A hung request (a flaky mobile network) otherwise kept every other tab waiting on each operation.
    vi.useFakeTimers()
    vi.stubGlobal('navigator', { locks: fakeLocks() })
    const [stuck, other] = [tab(), tab()]

    void acrossTabs(stuck, () => new Promise(() => {}))
    await vi.advanceTimersByTimeAsync(0)
    const order: string[] = []
    // Waits no longer than TAB_LOCK_WAIT_MS each: the first gives up, but once the holder's cap passes
    // the lock is free again and a later operation gets it at once.
    await vi.advanceTimersByTimeAsync(REFRESH_SETTLE_TIMEOUT)
    const later = acrossTabs(other, async () => { order.push('granted') })
    await vi.advanceTimersByTimeAsync(0)
    await later
    expect(order).toEqual(['granted'])
  })

  it('hands the lock back the moment its work is done, not when the next tab gives up waiting', async () => {
    // Releasing the Web Lock is what lets the next tab in. Left held, that tab still proceeds — after
    // waiting out TAB_LOCK_WAIT_MS — so every operation in every other tab pays three seconds and
    // nothing fails. The cost only shows up as a slow app.
    vi.useFakeTimers()
    vi.stubGlobal('navigator', { locks: fakeLocks() })
    const [one, two] = [tab(), tab()]

    await acrossTabs(one, async () => {})
    let ran = false
    const next = acrossTabs(two, async () => { ran = true })
    await vi.advanceTimersByTimeAsync(0)

    expect(ran).toBe(true)
    await next
  })

  it('releases the lock when the operation throws', async () => {
    vi.stubGlobal('navigator', { locks: fakeLocks() })
    const [one, two] = [tab(), tab()]

    await expect(acrossTabs(one, async () => { throw new Error('boom') })).rejects.toThrow('boom')

    await expect(acrossTabs(two, async () => 'next')).resolves.toBe('next')
  })

  it('simply runs where the browser has no Web Locks, or before the plugin named one', async () => {
    vi.stubGlobal('navigator', {})
    await expect(acrossTabs(tab(), async () => 'ran')).resolves.toBe('ran')

    vi.stubGlobal('navigator', { locks: fakeLocks() })
    await expect(acrossTabs({}, async () => 'ran')).resolves.toBe('ran')

    vi.stubGlobal('navigator', undefined)
    await expect(acrossTabs(tab(), async () => 'ran')).resolves.toBe('ran')
  })
})

describe('restore-state leaves nothing running behind it', () => {
  // Each of these timers is a cap on a wait that already ended. Left armed, every sign-in, refresh and
  // logout parks another one on the event loop for the length of its cap.
  it('settle disarms its cap once the promise answers', async () => {
    vi.useFakeTimers()
    await settle(Promise.resolve())
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a granted tab lock disarms its wait cap, and its hold cap once released', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('navigator', { locks: fakeLocks() })

    await acrossTabs(tab(), async () => {})

    expect(vi.getTimerCount()).toBe(0)
  })

  it('a lock request the browser refuses outright disarms its wait cap', async () => {
    // Not only the timeout: `request` rejects at once where the lock manager is unavailable to the page.
    vi.useFakeTimers()
    vi.stubGlobal('navigator', { locks: { request: () => Promise.reject(new DOMException('denied', 'SecurityError')) } })

    await acrossTabs(tab(), async () => {})

    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('signIn and beginSession', () => {
  it('releases the handover once the sign-in answered, so later refreshes do not wait on it', async () => {
    const app = {}

    await signIn(app, async () => 'answered', () => false)

    expect(restoreState(app).handover).toBeNull()
  })

  it('starts a session on an app without $lukk, rather than throwing after the server issued it', async () => {
    const app = {}

    await expect(signIn(app, async () => 'tokens', () => true)).resolves.toEqual({ result: 'tokens', current: true })
  })

  it('only ever moves the session generation forward', () => {
    // Generations are compared for equality, and other code moves them forward too: one that could step
    // back would land on a generation already handed out, and a stale flight would read as current.
    const app = {}
    const before = restoreState(app).epoch

    beginSession(app, Date.now())

    expect(restoreState(app).epoch).toBeGreaterThan(before)
  })
})

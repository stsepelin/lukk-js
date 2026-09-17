import { afterEach, describe, expect, it, vi } from 'vitest'
import { acrossTabs, REFRESH_SETTLE_TIMEOUT, restoreState, TAB_LOCK_WAIT_MS } from '../src/runtime/utils/restore-state'

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

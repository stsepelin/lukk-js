import { effectScope, nextTick, ref } from 'vue'
import { describe, expect, it } from 'vitest'
import { isPrematureWait, whenReady } from '../src/runtime/utils/when-ready'

/** Whether a promise has settled, without awaiting it to completion. */
async function settledYet(p: Promise<void>): Promise<boolean> {
  let done = false
  void p.then(() => { done = true })
  await nextTick()
  await Promise.resolve()
  return done
}

describe('whenReady', () => {
  it('resolves at once when the session is already resolved', async () => {
    expect(await settledYet(whenReady(ref(true), false))).toBe(true)
  })

  it('waits on the client until the session resolves', async () => {
    const ready = ref(false)
    const p = whenReady(ready, false)

    expect(await settledYet(p)).toBe(false)

    ready.value = true
    expect(await settledYet(p)).toBe(true)
  })

  it('releases every waiter on the same resolution', async () => {
    // A deep-link restore in `onMounted` and a watcher elsewhere can both be waiting.
    const ready = ref(false)
    const a = whenReady(ready, false)
    const b = whenReady(ready, false)

    ready.value = true

    expect(await settledYet(a)).toBe(true)
    expect(await settledYet(b)).toBe(true)
  })

  it('resolves at once on the server even when the session is NOT resolved', async () => {
    // Nothing later in a server request can settle the session — every plugin has already run —
    // so waiting would hang the render until the socket times out. The caller reads `ready`.
    expect(await settledYet(whenReady(ref(false), true))).toBe(true)
  })
})

describe('isPrematureWait', () => {
  it('flags only an unresolved client wait before the restore plugin has started', () => {
    expect(isPrematureWait(false, false, false)).toBe(true)

    expect(isPrematureWait(true, false, false)).toBe(false) // already resolved (a hydrated render)
    expect(isPrematureWait(false, true, false)).toBe(false) // the server has no restore plugin
    expect(isPrematureWait(false, false, true)).toBe(false) // the restore is under way
  })
})

describe('whenReady cleanup', () => {
  it('stops watching once the session resolves', async () => {
    // Every early caller installs a watcher on an app-wide ref; left running, each one lives as long as
    // the app does.
    const ready = ref(false)
    const scope = effectScope()
    const p = scope.run(() => whenReady(ready, false))!

    expect(scope.effects).toHaveLength(1)
    ready.value = true
    await p

    expect(scope.effects).toHaveLength(0)
    scope.stop()
  })
})

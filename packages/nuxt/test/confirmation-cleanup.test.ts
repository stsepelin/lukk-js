import { afterEach, describe, expect, it, vi } from 'vitest'

// Count live watchers: `watch` wrapped so each stop handle is tracked. The step-up watcher is created after
// an `await`, outside any effect scope, so its own stop handle is the only thing that ever ends it.
const live = vi.hoisted(() => ({ count: 0 }))
vi.mock('#imports', async (original) => {
  const actual = await original<typeof import('./mocks/imports')>()
  return {
    ...actual,
    watch: (...args: Parameters<typeof actual.watch>) => {
      const stop = (actual.watch as (...a: unknown[]) => () => void)(...args)
      live.count++
      let stopped = false
      return () => { if (!stopped) { stopped = true; live.count-- } stop() }
    },
  }
})

// eslint-disable-next-line import/first
import { __test } from './mocks/imports'
// eslint-disable-next-line import/first
import { useLukkConfirmation } from '../src/runtime/composables/useLukkConfirmation'

afterEach(() => { __test.reset(); live.count = 0 })

const tick = () => new Promise(resolve => setTimeout(resolve))

describe('useLukkConfirmation withConfirmation cleanup', () => {
  // Each step-up installs a watcher on app-wide state; left running, every one ever opened lives as long
  // as the app does.
  it.each(['confirmed', 'cancelled'] as const)('stops watching once the step-up is %s', async (ending) => {
    __test.nuxtApp = { $lukk: { confirmPassword: vi.fn().mockResolvedValue({ confirmation_token: 't' }) } }
    const flow = useLukkConfirmation()
    const idle = live.count
    let attempts = 0

    const pending = flow.withConfirmation(async () => { if (++attempts === 1) throw { status: 423 }; return 'ok' })
    await tick()
    expect(live.count).toBe(idle + 1)

    if (ending === 'confirmed') await flow.confirmPassword('secret')
    else flow.cancel()
    await pending.catch(() => {})

    expect(live.count).toBe(idle)
  })
})

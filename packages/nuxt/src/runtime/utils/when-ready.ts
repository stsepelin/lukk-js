import type { Ref } from 'vue'
import { watch } from '#imports'

/**
 * Resolve once `ready` is true — the session has been resolved one way or the other.
 *
 * Takes `isServer` as a parameter rather than reading `import.meta.server`, so both branches are
 * unit-testable (the same seam `createLukkFetch` uses).
 *
 * **On the server this resolves immediately, whatever `ready` says.** By the time route middleware,
 * `setup()` or a data handler runs, every plugin has already run, and nothing later in the request
 * can settle the session — so a promise waiting for it would hang the render until the socket times
 * out. The caller must still read `ready`: `false` there means the server could not tell, and the
 * client will decide after its restore.
 */
export function whenReady(ready: Readonly<Ref<boolean>>, isServer: boolean): Promise<void> {
  if (ready.value || isServer) return Promise.resolve()

  // Only installed while `ready` is false, and a watcher fires only on a change — so its first
  // callback necessarily sees `true`. `once` stops the watcher after that first callback.
  return new Promise((resolve) => {
    watch(ready, () => resolve(), { once: true })
  })
}

/**
 * Is a client-side `whenReady()` being called before the restore plugin has even started?
 *
 * Plugins run in sequence, so a plugin that AWAITS `whenReady()` in its setup and runs before
 * `lukk:session-restore` — `enforce: 'pre'`, or any module registered after lukk-nuxt, since
 * `addPlugin` prepends — waits on a plugin that cannot start until it returns. The app never boots.
 * Not an error on its own: a call that is not awaited in setup (a `.then`, a store) is fine.
 */
export function isPrematureWait(ready: boolean, isServer: boolean, restoreStarted: boolean): boolean {
  return !ready && !isServer && !restoreStarted
}

import type { Ref } from 'vue'
import { watch } from '#imports'

/**
 * Resolve once `ready` is true — the session has been resolved one way or the other.
 *
 * Takes `isServer` as a parameter rather than reading `import.meta.server`, so both branches are
 * unit-testable (the same seam `createLukkFetch` uses).
 *
 * **On the server this resolves immediately, whatever `ready` says.** The server never runs the client
 * restore, so an unhydrated render never becomes ready and a promise waiting for it would hang the
 * render until the socket times out. That includes a server plugin running BEFORE the hydration plugin:
 * waiting there would block the very plugin that could answer. The caller must still read `ready`:
 * `false` there means "not known here", and the client will decide after its restore.
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
 * `lukk:session-restore` — `enforce: 'pre'`, or a module registered after lukk-nuxt (`addPlugin`
 * prepends) — waits on a plugin that cannot start until it returns, and the app never boots. Adding
 * `dependsOn: ['lukk:client']` does not move such a plugin after the restore. A MAYBE, not a verdict: the same call is harmless
 * when it is not awaited in setup (a `.then`, a store), or in a `parallel` plugin — hence a warning.
 */
export function isPrematureWait(ready: boolean, isServer: boolean, restoreStarted: boolean): boolean {
  return !ready && !isServer && !restoreStarted
}

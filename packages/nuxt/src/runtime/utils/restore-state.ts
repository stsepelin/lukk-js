import type { Ref } from 'vue'
import { shallowRef } from '#imports'

/**
 * Restore bookkeeping that must outlive `clearNuxtState()`.
 *
 * `ready` is ALSO kept in `useState` — that is how the server hands "I hydrated a user" to the client
 * through the payload. But `useState` is the documented target of `clearNuxtState()`, a common logout
 * idiom: it resets the key (Nuxt 3 to `undefined`, Nuxt 4 deletes it), nothing sets it again, and every
 * later `whenReady()` hung. The restore has happened once per app, so the app is where that fact lives.
 */
export interface RestoreState {
  /** The client restore plugin has begun. A `whenReady()` before this is waiting on code not yet running. */
  started: boolean
  /** The client restore has finished. Reactive, so `ready` and `whenReady()` observe it. */
  restored: Ref<boolean>
  /**
   * Bumped by `logout()`. A restore that captured an older value discards its result: without this, a
   * restore still in flight when the user logged out wrote `user` and `restoreFailed` back afterwards.
   */
  epoch: number
}

export function restoreState(nuxtApp: object): RestoreState {
  const app = nuxtApp as { _lukkRestore?: RestoreState }
  return (app._lukkRestore ??= { started: false, restored: shallowRef(false), epoch: 0 })
}

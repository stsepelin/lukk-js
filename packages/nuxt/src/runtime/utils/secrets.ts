import type { Ref } from 'vue'
import { shallowRef, useNuxtApp } from '#imports'

/** The credentials the client holds in direct mode (BFF keeps them server-side, sealed). */
export type LukkSecret = 'access' | 'confirmation' | 'challenge'

/**
 * Where a direct-mode credential lives: on the Nuxt app, never in `useState`.
 *
 * `useState` is the payload. Written during SSR it serialises into `__NUXT_DATA__`; on the client, Nuxt's
 * chunk-reload (`reloadNuxtApp({ persistState: true })`) writes the whole of `payload.state` to
 * `sessionStorage` (`nuxt:reload:state`), where nothing clears it, and `experimental.restoreState`
 * re-applies it, stale, on the next load. An access token, a step-up token or a single-use 2FA challenge
 * must be in none of those places. Only non-secret flags (`confirmed`, `ready`, the user) stay in
 * `useState`.
 *
 * Per app, like the restore bookkeeping (`restoreState`): one per tab in the browser, one per request on
 * the server — where none is ever written (every writer is client-only).
 */
export function lukkSecret(nuxtApp: object, name: LukkSecret): Ref<string | null> {
  const app = nuxtApp as { _lukkSecrets?: Partial<Record<LukkSecret, Ref<string | null>>> }
  return ((app._lukkSecrets ??= {})[name] ??= shallowRef<string | null>(null))
}

/** {@link lukkSecret} for the current Nuxt app — call it where `useNuxtApp()` is valid. */
export function useLukkSecret(name: LukkSecret): Ref<string | null> {
  return lukkSecret(useNuxtApp(), name)
}

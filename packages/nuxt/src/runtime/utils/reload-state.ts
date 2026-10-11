import { FORM_KEY_PREFIX } from '../keys'

/** Where Nuxt keeps `payload.state` across a reload it makes itself (`reloadNuxtApp({ persistState: true })`). */
const RELOAD_STATE_KEY = 'nuxt:reload:state'

/**
 * Take lukk's session state out of the snapshot Nuxt restores after a reload of its own.
 *
 * A chunk error, or a new deploy's manifest, makes Nuxt reload the page with `persistState`: the whole
 * `payload.state` goes to sessionStorage, and with `experimental.restoreState` it is assigned back at
 * `app:mounted` — after lukk has restored the session for the new page. A stale `lukk:user` (another account,
 * or nobody since a logout in another tab), `lukk:confirmed` (a step-up the session no longer holds) or
 * `lukk:ready` then overwrote what was just resolved. Dropped before that can happen; the session is resolved
 * afresh anyway. Form drafts (`lukk:form:*`) stay — keeping a draft across a reload is what they are for —
 * and so does the app's own state.
 */
export function dropLukkReloadState(): void {
  try {
    const saved = sessionStorage.getItem(RELOAD_STATE_KEY)
    const snapshot = JSON.parse(saved!) as { state?: Record<string, unknown> }
    const kept = Object.entries(snapshot.state!).filter(([key]) => !key.startsWith('$slukk:') || key.startsWith(`$s${FORM_KEY_PREFIX}:`))
    sessionStorage.setItem(RELOAD_STATE_KEY, JSON.stringify({ ...snapshot, state: Object.fromEntries(kept) }))
  }
  catch {
    // No sessionStorage (the server, a sandboxed frame), no snapshot, or not one Nuxt wrote: nothing to drop.
  }
}

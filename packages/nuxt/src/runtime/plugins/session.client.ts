import { useLukkAuth } from '../composables/useLukkAuth'
import { ACCESS_KEY, READY_KEY } from '../keys'
import { clearLogoutCookie, hasLogoutCookie, setLogoutCookie } from '../utils/logout-cookie'
import { clearPendingLogout, readPendingLogout, signedInSince } from '../utils/pending-logout'
import { restoreState } from '../utils/restore-state'
import { tokenFamily } from '../utils/token-subject'
import { defineNuxtPlugin, useNuxtApp, useRuntimeConfig, useState } from '#imports'

/**
 * On app load in the browser, silently restore the session: if a valid refresh
 * cookie / sealed session exists, this mints a fresh access token and loads the
 * user, so a returning visitor is already authenticated.
 *
 * `dependsOn` the client plugin so `$lukkRefresh` is guaranteed provided before
 * `initSession` runs (initSession also guards the call defensively regardless, so
 * a missing provide degrades to logged-out instead of throwing).
 *
 * Owns `ready`: it is the one place that knows the session has been resolved on the client. Nuxt
 * awaits this plugin before the initial navigation and before mounting, so route middleware,
 * `setup()` and `onMounted` all see it settled.
 */
export default defineNuxtPlugin({
  name: 'lukk:session-restore',
  dependsOn: ['lukk:client'],
  async setup() {
    const auth = useLukkAuth()
    const ready = useState<boolean>(READY_KEY, () => false)
    const state = restoreState(useNuxtApp())
    state.started = true

    try {
      // A previous page started a logout it may not have finished — it navigated away first, and this
      // page's request could still carry the session. Its errors surface nowhere else, so they are swallowed.
      const cfg = useRuntimeConfig().public.lukk as { mode: 'bff' | 'direct', logoutCookie?: string, signedOutCookie?: string }
      const noteCookie = cfg.mode === 'bff' ? cfg.logoutCookie : undefined
      const signedOutCookie = cfg.mode === 'bff' ? cfg.signedOutCookie : undefined
      const note = noteCookie ? undefined : readPendingLogout(state.scope)

      // BFF: the server finishes it before rendering this page, and clears the cookie. Still here, it
      // couldn't (lukk unreachable, a page served without the server). The server rendered this page
      // signed out all the same, so there is nothing to restore — and nothing to hold startup for: lukk
      // may be hanging. It stands down if a sign-in is recorded while it waits (see `logout`).
      if (noteCookie && hasLogoutCookie(noteCookie)) {
        // A fresh minute: the replay may wait seconds for the lock, and the next page load needs the note
        // to still be there. Only renewed while one is already standing — never written from nothing.
        setLogoutCookie(noteCookie)
        state.finishingLogout = Date.now()
        void auth.logout().then(() => {
          // It stood down: a sign-in elsewhere replaced that session, and this tab should show it.
          if (!state.logoutStoodDown) return
          state.logoutStoodDown = false
          return auth.initSession()
        }).catch(() => {})
      }
      // BFF: the server ended the session before this page, and said so in a cookie — per browser, so no
      // cached page can carry it. Signed out, and known: no restore to wait on (another tab's lock held it
      // for seconds). Other tabs still show the account: tell them.
      else if (signedOutCookie && hasLogoutCookie(signedOutCookie)) {
        clearLogoutCookie(signedOutCookie)
        state.announce?.()
      }
      // Direct, for a known session: restore, and end what was restored only if it is that session. The
      // cookie may hold a newer sign-in by now, from anywhere.
      else if (note?.fid !== undefined) {
        await auth.initSession()
        const access = useState<string | null>(ACCESS_KEY, () => null)
        // On the restored session's FAMILY, not on `loggedIn`: an app with no `user.endpoint` never reads as
        // logged in, and this branch would then drop the note of a session the restore had just renewed.
        if (tokenFamily(access.value) === note.fid) await auth.logout().catch(() => {})
        // Couldn't tell (lukk unreachable): the note stands, for the next load within its minute.
        else if (!auth.restoreFailed.value) {
          clearPendingLogout(state.scope)
          // Gone already — the page's send on the way out ended it. Other tabs still show the account.
          if (!auth.loggedIn.value) state.announce?.()
        }
      }
      // Direct, session unknown: by time — the logout stands down if a sign-in was sent after it.
      else if (note) {
        state.finishingLogout = note.at
        await auth.logout().catch(() => {})
        state.logoutStoodDown = false // read by time here, not by the flag
        if (signedInSince(state.scope, note.at)) await auth.initSession()
      }
      // If SSR already hydrated the user (BFF `ssrHydrate`), skip the client restore — no
      // redundant refresh on every page load. Anonymous / expired-at-SSR renders leave `user`
      // null, so this still restores them.
      else if (!auth.loggedIn.value) await auth.initSession()
    }
    finally {
      // In `finally`, not after the await: `whenReady()` waits on this flag, and a restore that threw
      // would otherwise leave every waiter pending forever. A settled-as-signed-out session is a
      // recoverable answer; a promise that never resolves is not.
      ready.value = true
      // The app-scoped copy is the one `clearNuxtState()` cannot reset — see utils/restore-state.
      state.restored.value = true
    }
  },
})

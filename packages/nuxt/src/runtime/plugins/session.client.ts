import { useLukkAuth } from '../composables/useLukkAuth'
import { READY_KEY } from '../keys'
import { pendingLogoutAt, signedInSince } from '../utils/pending-logout'
import { restoreState } from '../utils/restore-state'
import { defineNuxtPlugin, useNuxtApp, useState } from '#imports'

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
      // The previous page in this tab started a logout it may not have finished — it navigated away
      // first, and this page's request (and a server render) could still carry the session. Finish it
      // before restoring anything; its errors surface nowhere else, so they are swallowed.
      const noted = pendingLogoutAt(state.scope)
      if (noted !== undefined) {
        state.finishingLogout = noted
        await auth.logout().catch(() => {})
        // Unless a sign-in sent meanwhile in another tab made it moot: then the logout stood down, and the
        // cookie holds that newer session — restore it.
        if (signedInSince(state.scope, noted)) await auth.initSession()
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

import { useLukkAuth } from '../composables/useLukkAuth'
import { defineNuxtPlugin } from '#imports'

/**
 * On app load in the browser, silently restore the session: if a valid refresh
 * cookie / sealed session exists, this mints a fresh access token and loads the
 * user, so a returning visitor is already authenticated.
 *
 * `dependsOn` the client plugin so `$lukkRefresh` is guaranteed provided before
 * `initSession` runs (initSession also guards the call defensively regardless, so
 * a missing provide degrades to logged-out instead of throwing).
 */
export default defineNuxtPlugin({
  name: 'lukk:session-restore',
  dependsOn: ['lukk:client'],
  async setup() {
    await useLukkAuth().initSession()
  },
})

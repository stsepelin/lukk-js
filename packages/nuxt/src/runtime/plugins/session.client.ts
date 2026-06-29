import { useLukkAuth } from '../composables/useLukkAuth'
import { defineNuxtPlugin } from '#imports'

/**
 * On app load in the browser, silently restore the session: if a valid refresh
 * cookie / sealed session exists, this mints a fresh access token and loads the
 * user, so a returning visitor is already authenticated.
 */
export default defineNuxtPlugin(async () => {
  await useLukkAuth().initSession()
})

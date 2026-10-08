import type { LoginResult } from 'lukk-core'

/**
 * The shared sign-in completion `useLukkAuth` carries under this symbol, for lukk-nuxt's own composables.
 * Outside `composables/` because every export there is auto-imported into the app, and this is not
 * public API.
 */
export const SIGN_IN = Symbol('lukk.signIn')

export type SignInWith = (send: () => Promise<LoginResult>) => Promise<LoginResult>

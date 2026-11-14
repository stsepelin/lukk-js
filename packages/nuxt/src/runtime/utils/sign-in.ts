import type { LoginResult } from 'lukk-core'
import type { BffSignInResult } from '../composables/useLukkAuth'

/**
 * The shared sign-in completion `useLukkAuth` carries under this symbol, for lukk-nuxt's own composables.
 * Outside `composables/` because every export there is auto-imported into the app, and this is not
 * public API.
 */
export const SIGN_IN = Symbol('lukk.signIn')

/**
 * Reload the user for a session another tab says has CHANGED. Carried the same way, for the client plugin.
 */
export const FOLLOW_SESSION = Symbol('lukk.followSession')

export type FollowSession = () => Promise<void>

export type SignInWith = (send: () => Promise<LoginResult | BffSignInResult>) => Promise<LoginResult | BffSignInResult>

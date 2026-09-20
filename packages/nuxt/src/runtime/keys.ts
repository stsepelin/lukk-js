// Shared `useState` keys — one source of truth so the plugin, composables, and
// proxy can never drift on a literal.
export const ACCESS_KEY = 'lukk:access'
export const USER_KEY = 'lukk:user'
// Whether the session has been RESOLVED — not whether anyone is signed in. See `useLukkAuth().ready`.
export const READY_KEY = 'lukk:ready'
// Whether the last restore could not reach an answer (throttled, 5xx, unreachable). See `restoreFailed`.
export const RESTORE_FAILED_KEY = 'lukk:restore-failed'
export const CHALLENGE_KEY = 'lukk:challenge'
export const CONFIRMATION_KEY = 'lukk:confirmation'
export const CONFIRMED_KEY = 'lukk:confirmed'
export const CONFIRM_REQUIRED_KEY = 'lukk:confirm-required'

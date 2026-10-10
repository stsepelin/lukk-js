import type { RecoveryCodeCount, TwoFactorEnrollment } from 'lukk-core'
import { useNuxtApp } from '#imports'

/**
 * Declared rather than inferred: the module build cannot resolve `#imports`, so an inferred return type
 * shipped as `any` in the published declarations — every method here returned `any`.
 */
export interface LukkTwoFactor {
  /** Begin enrolment → `{ otpauth_uri, recovery_codes }` (shown once). */
  enable: () => Promise<TwoFactorEnrollment>
  /** Activate 2FA by confirming the first TOTP code. Rejects `409` (on `code`) when two-factor is already on. */
  confirm: (code: string) => Promise<void>
  /** Turn 2FA off. */
  disable: () => Promise<void>
  /** How many recovery codes remain — a safe count, never the codes. */
  recoveryCodeCount: () => Promise<RecoveryCodeCount>
  /**
   * Replace the recovery codes, returning the new set once. Rejects `409` (on `two_factor`) on an account
   * whose two-factor is neither on nor being enrolled.
   */
  regenerateRecoveryCodes: () => Promise<{ recovery_codes: string[] }>
}

/**
 * Two-factor *management* (distinct from the login challenge in `useLukkAuth`).
 * These all sit behind step-up confirmation on the server, so earn a
 * confirmation token first (`useLukkConfirmation`) — the client attaches it
 * automatically.
 */
export function useLukkTwoFactor(): LukkTwoFactor {
  const { $lukk } = useNuxtApp()

  return {
    /** Begin enrolment → `{ otpauth_uri, recovery_codes }` (shown once). */
    enable: () => $lukk.enableTwoFactor(),
    /** Activate 2FA by confirming the first TOTP code. Rejects `409` (on `code`) when two-factor is already on. */
    confirm: (code: string) => $lukk.confirmTwoFactor(code),
    /** Turn 2FA off. */
    disable: () => $lukk.disableTwoFactor(),
    /** How many recovery codes remain — a safe count, never the codes. */
    recoveryCodeCount: () => $lukk.recoveryCodeCount(),
    /** Replace the recovery codes, returning the new set once (`409` without two-factor — see above). */
    regenerateRecoveryCodes: () => $lukk.regenerateRecoveryCodes(),
  }
}

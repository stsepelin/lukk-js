import { useNuxtApp } from '#imports'

/**
 * Two-factor *management* (distinct from the login challenge in `useLukkAuth`).
 * These all sit behind step-up confirmation on the server, so earn a
 * confirmation token first (`useLukkConfirmation`) — the client attaches it
 * automatically.
 */
export function useLukkTwoFactor() {
  const { $lukk } = useNuxtApp()

  return {
    /** Begin enrolment → `{ otpauth_uri, recovery_codes }` (shown once). */
    enable: () => $lukk.enableTwoFactor(),
    /** Activate 2FA by confirming the first TOTP code. */
    confirm: (code: string) => $lukk.confirmTwoFactor(code),
    /** Turn 2FA off. */
    disable: () => $lukk.disableTwoFactor(),
    /** How many recovery codes remain — a safe count, never the codes. */
    recoveryCodeCount: () => $lukk.recoveryCodeCount(),
    /** Replace the recovery codes, returning the new set once. */
    regenerateRecoveryCodes: () => $lukk.regenerateRecoveryCodes(),
  }
}

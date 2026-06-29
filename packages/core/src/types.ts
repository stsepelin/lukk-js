/**
 * The lukk HTTP contract, mirrored in TypeScript.
 *
 * Source of truth: the lukk package docs/source. These shapes are
 * conformance-tested against a real lukk instance (see `conformance/`), so they
 * must not drift from the server. Endpoint paths assume the default `auth` prefix.
 */

/** Authentication methods recorded in the access token's `amr` claim. */
export type Amr = 'pwd' | 'otp' | 'webauthn'

/** A successful login / refresh — the token pair. In cookie/BFF mode the
 *  refresh token is delivered out-of-band (cookie / sealed session), so it is
 *  absent from the body. */
export interface TokenPair {
  access_token: string
  token_type?: 'Bearer'
  expires_in: number
  /** Present only in BFF (body) mode; absent in cookie mode. */
  refresh_token?: string
}

/** `POST /auth/login` when the user has 2FA enabled: a challenge, not tokens. */
export interface TwoFactorChallenge {
  two_factor: true
  challenge_token: string
}

/** `POST /auth/login` result — a token pair, or a 2FA challenge. */
export type LoginResult = TokenPair | TwoFactorChallenge

export function isTwoFactorChallenge(r: LoginResult): r is TwoFactorChallenge {
  return (r as TwoFactorChallenge).two_factor === true
}

export interface LoginCredentials {
  email: string
  password: string
}

/** Completing a 2FA login at `POST /auth/two-factor-challenge`. */
export interface TwoFactorChallengeInput {
  challenge_token: string
  /** A TOTP code, or `recovery_code` — exactly one. */
  code?: string
  recovery_code?: string
}

/** `POST /auth/two-factor` enrolment response (shown once). */
export interface TwoFactorEnrollment {
  otpauth_uri: string
  recovery_codes: string[]
}

/** `GET /auth/two-factor/recovery-codes` — a safe count, never the codes. */
export interface RecoveryCodeCount {
  remaining: number
  total: number
}

/** `POST /auth/confirm-password|confirm-passkey` — a step-up token, sent back
 *  in the `X-Lukk-Confirmation` header on `lukk.confirm`-gated requests. */
export interface ConfirmationToken {
  confirmation_token: string
}

/** A user's stored passkey summary (`GET /auth/passkeys`). Never the COSE key. */
export interface PasskeySummary {
  id: string
  name: string | null
  last_used_at: string | null
}

/** `POST /auth/passkeys/login-options` — opaque ceremony id + WebAuthn options. */
export interface PasskeyLoginOptions {
  ceremony_id: string
  options: PublicKeyCredentialRequestOptionsJSON
}

/** WebAuthn options as lukk emits them (base64url strings, not ArrayBuffers). */
export interface PublicKeyCredentialCreationOptionsJSON {
  challenge: string
  rp: { id?: string, name: string }
  user: { id: string, name: string, displayName: string }
  pubKeyCredParams: { type: 'public-key', alg: number }[]
  excludeCredentials?: { type: 'public-key', id: string, transports?: string[] }[]
  authenticatorSelection?: { userVerification?: UserVerificationRequirement }
  timeout?: number
  attestation?: string
}

export interface PublicKeyCredentialRequestOptionsJSON {
  challenge: string
  rpId?: string
  allowCredentials?: { type: 'public-key', id: string, transports?: string[] }[]
  userVerification?: UserVerificationRequirement
  timeout?: number
}

export type UserVerificationRequirement = 'required' | 'preferred' | 'discouraged'

/** Transport mode — see PLAN.md. */
export type LukkMode = 'bff' | 'direct'

export interface LukkError {
  status: number
  message: string
  /** Laravel validation errors, when present (422). */
  errors?: Record<string, string[]>
}

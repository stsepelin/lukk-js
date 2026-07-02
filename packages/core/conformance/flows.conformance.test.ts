import { createPublicKey, verify as cryptoVerify } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { createLukkClient, credentialToJSON, isTwoFactorChallenge } from '../src'
import { createAuthenticator, totp } from './authenticator'

// Runs against a REAL lukk instance (see ../../../conformance). Opt-in:
//   docker compose -f conformance/docker-compose.yml up -d
//   pnpm --filter lukk-core test:conformance
// The conformance MATRIX (conformance/matrix.sh) boots the fixture in every
// feature/algorithm/delivery combo and sets the env flags below so this suite
// runs only the flows the current combo actually enables.
const BASE = process.env.LUKK_URL ?? 'http://localhost:8000/auth'
const ROOT = BASE.replace(/\/auth$/, '')
const COOKIE_MODE = process.env.LUKK_COOKIE_MODE === 'true'
const ALGORITHM = (process.env.LUKK_ALGORITHM ?? 'HS256').toUpperCase()

// Feature flags mirror the fixture's LUKK_FEAT_* (default all-on, matching the
// original single-config fixture) so a plain `up` + test run still exercises everything.
const FEAT_2FA = (process.env.LUKK_FEAT_2FA ?? 'true') === 'true'
const FEAT_PASSKEYS = (process.env.LUKK_FEAT_PASSKEYS ?? 'true') === 'true'
const FEAT_EMAIL = (process.env.LUKK_FEAT_EMAIL ?? 'false') === 'true'

const USER = 'user@example.com'
const TWO_FACTOR_USER = '2fa@example.com'
const UNVERIFIED_USER = 'unverified@example.com'
const PASSWORD = 'password'
// Match the fixture seed + passkey config (conformance/fixture).
const TWO_FACTOR_SECRET = 'JBSWY3DPEHPK3PXP'
const RP_ID = 'localhost'
const ORIGIN = 'http://localhost:8000'

/** A cookie jar so cookie-mode (refresh in the `__Host-` cookie) works under node fetch. */
function makeJar(): typeof fetch {
  const cookies = new Map<string, string>()
  return async (input, init) => {
    const headers = new Headers(init?.headers)
    if (cookies.size) headers.set('cookie', [...cookies].map(([k, v]) => `${k}=${v}`).join('; '))
    const res = await fetch(input, { ...init, headers })
    for (const sc of res.headers.getSetCookie?.() ?? []) {
      const first = sc.split(';')[0] ?? ''
      const eq = first.indexOf('=')
      if (eq > 0) cookies.set(first.slice(0, eq).trim(), first.slice(eq + 1).trim())
    }
    return res
  }
}

function client() {
  const fetchWithJar = makeJar()
  const state: { access: string | null, refresh?: string, confirmation: string | null } = { access: null, confirmation: null }
  const lukk = createLukkClient({
    baseURL: BASE,
    fetch: fetchWithJar,
    getAccessToken: () => state.access,
    getConfirmationToken: () => state.confirmation,
    onTokens: (p) => { state.access = p.access_token; if (p.refresh_token) state.refresh = p.refresh_token },
    // Direct mode relies on the cookie; body mode passes the stored refresh token.
    refresh: () => lukk.refreshTokens(COOKIE_MODE ? undefined : state.refresh),
  })
  return { lukk, state }
}

/** Independently verify an access-token JWS against the published JWKS, with node:crypto only. */
function verifyAgainstJwks(token: string, jwks: { keys: Array<Record<string, string>> }): boolean {
  const [h, p, s] = token.split('.')
  if (!h || !p || !s) return false
  const header = JSON.parse(Buffer.from(h, 'base64url').toString()) as { kid?: string, alg: string }
  const jwk = jwks.keys.find(k => k.kid === header.kid) ?? jwks.keys[0]
  if (!jwk) return false
  const key = createPublicKey({ key: jwk as object, format: 'jwk' })
  const data = Buffer.from(`${h}.${p}`)
  const sig = Buffer.from(s, 'base64url')
  // Pin the alg from the expected config (ALGORITHM), NOT the token header — mirrors lukk's
  // own invariant. JWS ECDSA signatures are raw r||s (IEEE P1363), not DER — tell node so.
  return ALGORITHM.startsWith('ES')
    ? cryptoVerify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, sig)
    : cryptoVerify('RSA-SHA256', data, key, sig)
}

describe(`lukk conformance (algo=${ALGORITHM}, cookie_mode=${COOKIE_MODE}, feat=2fa:${FEAT_2FA}/passkeys:${FEAT_PASSKEYS}/email:${FEAT_EMAIL})`, () => {
  beforeAll(async () => {
    const res = await fetch(`${ROOT}/up`).catch(() => null)
    if (!res?.ok) throw new Error(`No lukk instance at ${BASE}. Boot the fixture first (see conformance/README.md).`)
  })

  it('logs in with a password and returns a token pair', async () => {
    const { lukk } = client()
    const result = await lukk.login({ email: USER, password: PASSWORD })

    expect(isTwoFactorChallenge(result)).toBe(false)
    if (isTwoFactorChallenge(result)) return
    expect(typeof result.access_token).toBe('string')
    expect(typeof result.expires_in).toBe('number')
    // The refresh token is in the body only in BFF (non-cookie) mode.
    expect(typeof result.refresh_token === 'string').toBe(!COOKIE_MODE)
  })

  it('rejects bad credentials with a typed validation error', async () => {
    const { lukk } = client()
    await expect(lukk.login({ email: USER, password: 'wrong' }))
      .rejects.toMatchObject({ status: expect.any(Number) })
  })

  it.runIf(FEAT_2FA)('surfaces then completes a 2FA challenge with a TOTP code', async () => {
    const { lukk } = client()
    const challenge = await lukk.login({ email: TWO_FACTOR_USER, password: PASSWORD })

    expect(isTwoFactorChallenge(challenge)).toBe(true)
    if (!isTwoFactorChallenge(challenge)) return
    const pair = await lukk.twoFactorChallenge({ challenge_token: challenge.challenge_token, code: totp(TWO_FACTOR_SECRET) })
    expect(typeof pair.access_token).toBe('string')
  })

  it('rotates the token pair on refresh', async () => {
    const { lukk, state } = client()
    await lukk.login({ email: USER, password: PASSWORD })
    const pair = await lukk.refreshTokens(COOKIE_MODE ? undefined : state.refresh)

    expect(typeof pair.access_token).toBe('string')
    expect(typeof pair.expires_in).toBe('number')
  })

  it('accepts the access token on an authenticated route, then logout revokes the session', async () => {
    const { lukk, state } = client()
    await lukk.login({ email: USER, password: PASSWORD })

    await expect(lukk.revokeOtherSessions()).resolves.not.toThrow()
    await lukk.logout()
    await expect(lukk.refreshTokens(COOKIE_MODE ? undefined : state.refresh)).rejects.toBeTruthy()
  })

  it('issues a step-up confirmation token for a valid password', async () => {
    const { lukk } = client()
    await lukk.login({ email: USER, password: PASSWORD })
    const { confirmation_token } = await lukk.confirmPassword(PASSWORD)

    expect(typeof confirmation_token).toBe('string')
  })

  it.runIf(FEAT_PASSKEYS)('registers a passkey under step-up, then logs in with it', async () => {
    // Register: authenticate, confirm (step-up), then attest a new credential.
    const { lukk, state } = client()
    await lukk.login({ email: USER, password: PASSWORD })
    state.confirmation = (await lukk.confirmPassword(PASSWORD)).confirmation_token

    const authenticator = createAuthenticator(RP_ID, ORIGIN)
    const regOptions = await lukk.passkeyRegistrationOptions()
    await lukk.registerPasskey(credentialToJSON(authenticator.create(regOptions)), 'Conformance Key')

    // Passwordless login with that credential, on a fresh client.
    const { lukk: fresh } = client()
    const loginOptions = await fresh.passkeyLoginOptions()
    const pair = await fresh.loginWithPasskey(loginOptions.ceremony_id, credentialToJSON(authenticator.get(loginOptions.options)))

    expect(typeof pair.access_token).toBe('string')
  })

  // NOTE: permanently verifies unverified@example.com — the matrix runner reseeds per combo,
  // so a re-run without a DB reset would fail the initial "unverified" precondition.
  it.runIf(FEAT_EMAIL)('verifies an email end-to-end via the signed link', async () => {
    // Log in as the seeded unverified user, resend the link, fetch it out-of-band
    // (the log mailer + the test-only fixture route), click it, and confirm the flip.
    const { lukk } = client()
    await lukk.login({ email: UNVERIFIED_USER, password: PASSWORD })
    await expect(lukk.sendEmailVerification()).resolves.not.toThrow()

    const { url } = await (await fetch(`${ROOT}/conformance/last-verification-url`)).json() as { url: string | null }
    expect(url, 'a signed verification URL should have been mailed').toBeTruthy()

    const hit = await fetch(url!, { headers: { accept: 'application/json' } })
    expect(hit.status).toBe(204) // empty frontend_url → JSON client gets 204

    const { verified } = await (await fetch(`${ROOT}/conformance/user-verified?email=${encodeURIComponent(UNVERIFIED_USER)}`)).json() as { verified: boolean }
    expect(verified).toBe(true)
  })

  it.skipIf(ALGORITHM === 'HS256')('publishes a JWKS that independently verifies an issued access token', async () => {
    // The "separate resource server verifies via JWKS" topology: a party that never
    // holds the signing key can validate tokens from the public JWK set alone.
    const jwks = await (await fetch(`${ROOT}/auth/jwks`)).json() as { keys: Array<Record<string, string>> }
    expect(jwks.keys.length).toBeGreaterThan(0)

    const { lukk } = client()
    const result = await lukk.login({ email: USER, password: PASSWORD })
    if (isTwoFactorChallenge(result)) throw new Error('unexpected 2FA challenge')

    expect(verifyAgainstJwks(result.access_token, jwks)).toBe(true)
    // A tampered token must fail the same check.
    const tampered = `${result.access_token.slice(0, -4)}AAAA`
    expect(verifyAgainstJwks(tampered, jwks)).toBe(false)
  })
})

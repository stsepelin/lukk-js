import { beforeAll, describe, expect, it } from 'vitest'
import { createLukkClient, credentialToJSON, isTwoFactorChallenge } from '../src'
import { createAuthenticator, totp } from './authenticator'

// Runs against a REAL lukk instance (see ../../../conformance). Opt-in:
//   docker compose -f conformance/docker-compose.yml up -d
//   pnpm --filter lukk-core test:conformance
const BASE = process.env.LUKK_URL ?? 'http://localhost:8000/auth'
const COOKIE_MODE = process.env.LUKK_COOKIE_MODE === 'true'

const USER = 'user@example.com'
const TWO_FACTOR_USER = '2fa@example.com'
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

describe(`lukk conformance (cookie_mode=${COOKIE_MODE})`, () => {
  beforeAll(async () => {
    const res = await fetch(BASE.replace(/\/auth$/, '') + '/up').catch(() => null)
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

  it('surfaces then completes a 2FA challenge with a TOTP code', async () => {
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

  it('registers a passkey under step-up, then logs in with it', async () => {
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
})

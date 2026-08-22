import { createPublicKey, verify as cryptoVerify } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import type { AccountExport } from '../src'
import { can, canAll, canAny, createLukkClient, credentialToJSON, isTwoFactorChallenge, shapeUser } from '../src'
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
/**
 * Abilities are detected, not declared.
 *
 * The other feature flags are told to the fixture by the runner, so the runner already knows them.
 * This one's real gate is `class_exists(Lukk\Support\Abilities)` inside the fixture — whether the
 * INSTALLED lukk has the feature at all — which the runner cannot know without duplicating
 * composer's resolution. Defaulting it to `true` meant an older server failed five tests instead of
 * skipping them.
 *
 * 404 = the fixture never registered the gated routes (old lukk, or the feature switched off);
 * 401 = registered and reachable. `LUKK_FEAT_ABILITIES=false` still forces a skip explicitly.
 *
 * Top-level, not in `beforeAll`: `describe.runIf` is evaluated at collection time.
 */
const FEAT_ABILITIES = await (async () => {
  if (process.env.LUKK_FEAT_ABILITIES === 'false') return false

  const status = await fetch(`${ROOT}/gated/any`, { headers: { accept: 'application/json' } })
    .then(r => r.status)
    .catch(() => 0)

  // Loud on purpose — an invisible skip is how a suite passes while covering nothing.
  if (status !== 401) console.warn(`conformance: skipping abilities — GET ${ROOT}/gated/any returned ${status}, expected 401`)

  return status === 401
})()

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

  describe.runIf(FEAT_ABILITIES)('abilities', () => {
    // The fixture grants user #1 exactly `['orders.read', 'billing.*']` and gates one route per
    // shape the matcher has to handle. See conformance/fixture/build.sh.
    const GATES = [
      // [route,                 required,                            requireAll]
      ['/gated/any', ['orders.read', 'orders.write'], false],
      ['/gated/all', ['orders.read', 'orders.write'], true],
      ['/gated/prefix', ['billing.view'], false],
      ['/gated/bare-namespace', ['billing'], false],
      ['/gated/wildcard-check', ['orders.*'], false],
      ['/gated/denied', ['admin.impersonate'], false],
    ] as const

    async function loginAndLoadUser() {
      const { lukk, state } = client()
      const result = await lukk.login({ email: USER, password: PASSWORD })
      if (isTwoFactorChallenge(result)) throw new Error('unexpected 2FA challenge')
      const raw = await (await fetch(`${ROOT}/user`, {
        headers: { accept: 'application/json', authorization: `Bearer ${state.access}` },
      })).json()
      return { access: state.access!, user: shapeUser(raw) }
    }

    it('publishes the token\'s abilities on the user resource', async () => {
      // In BFF mode the browser never sees the access token, so this is the ONLY channel the
      // client has for them. If it stops being emitted, every `can()` silently returns true.
      const { user } = await loginAndLoadUser()

      expect(user?.abilities, 'lukk >= 0.6 UserResource should publish `abilities`').toEqual(['orders.read', 'billing.*'])
    })

    it('predicts every server gate exactly — the matcher cannot drift', async () => {
      // The point of the whole suite in one test: two independent implementations of the same
      // matching rules (PHP `Lukk\\Support\\Abilities`, TS `can/canAny/canAll`) asked the same
      // questions, and required to agree. A wildcard, case, or prefix rule that changes on one
      // side and not the other fails here rather than in someone's UI.
      const { access, user } = await loginAndLoadUser()
      const granted = user?.abilities

      for (const [route, required, requireAll] of GATES) {
        const predicted = requireAll ? canAll(granted, [...required]) : canAny(granted, [...required])
        const res = await fetch(`${ROOT}${route}`, {
          headers: { accept: 'application/json', authorization: `Bearer ${access}` },
        })

        expect(res.status, `${route} required=${required.join(',')} all=${requireAll}`).toBe(predicted ? 200 : 403)
      }
    })

    it('answers insufficient_scope, naming what would have sufficed (RFC 6750 §3.1)', async () => {
      // A generic OAuth client or an API gateway acts on this header without knowing about lukk.
      const { access } = await loginAndLoadUser()
      const res = await fetch(`${ROOT}/gated/denied`, {
        headers: { accept: 'application/json', authorization: `Bearer ${access}` },
      })

      expect(res.status).toBe(403)
      const challenge = res.headers.get('www-authenticate') ?? ''
      expect(challenge).toContain('error="insufficient_scope"')
      expect(challenge).toContain('scope="admin.impersonate"')
    })

    it('challenges — rather than refuses — a gated route reached with no token', async () => {
      const res = await fetch(`${ROOT}/gated/any`, { headers: { accept: 'application/json' } })

      expect(res.status).toBe(401)
    })

    /** A session whose grant the TOKEN owns. Omit `abilities` for an ordinary derived one. */
    async function pinnedToken(abilities?: string): Promise<string> {
      const query = abilities === undefined ? '' : `?abilities=${encodeURIComponent(abilities)}`
      const pair = await (await fetch(`${ROOT}/conformance/pinned-token${query}`)).json() as { access_token: string }

      return pair.access_token
    }

    function authed(token: string) {
      return { headers: { accept: 'application/json', authorization: `Bearer ${token}` } }
    }

    // Every route lukk gates for a pinned token, and the ability each one needs.
    const OWN_ROUTES = [
      ['DELETE', '/auth/sessions', 'lukk.sessions'],
      ['DELETE', '/auth/sessions/others', 'lukk.sessions'],
      ['POST', '/auth/confirm-password', 'lukk.account'],
      ['POST', '/auth/password', 'lukk.account'],
      ['GET', '/auth/passkeys', 'lukk.account'],
      ['GET', '/auth/two-factor/recovery-codes', 'lukk.account'],
      // The account routes need their OWN ability: `lukk.account` does not satisfy
      // `lukk.account.delete`. Safe in this loop because the derived leg only asserts "not 403" —
      // which the step-up gate satisfies with a 423, without erasing anything.
      ['GET', '/auth/account/export', 'lukk.account.delete'],
      ['DELETE', '/auth/account', 'lukk.account.delete'],
    ] as const

    it('marks a pinned session, and only a pinned one', async () => {
      // `pin` is what lukk's own gates key on, and `token_pinned` is the only way a client can tell
      // the two apart — `abilities` alone can't, since a derived grant never carries `lukk.sessions`.
      const pinned = await pinnedToken('ci.deploy')
      const derived = await pinnedToken()

      const claims = (t: string) => JSON.parse(Buffer.from(t.split('.')[1]!, 'base64url').toString()) as Record<string, unknown>

      expect(claims(pinned).pin).toBe(true)
      expect(claims(pinned).scope).toBe('ci.deploy')
      expect(claims(derived).pin).toBeUndefined()

      const user = async (t: string) => shapeUser(await (await fetch(`${ROOT}/user`, authed(t))).json())
      expect((await user(pinned))?.token_pinned).toBe(true)
      expect((await user(derived))?.token_pinned).toBe(false)
    })

    it('refuses a pinned token every route lukk gates, and lets a derived one through', async () => {
      // The gap this closes: the suite's step-up test used a DERIVED token, which is never gated —
      // so it passed whether or not the gate existed. Nothing here exercised a pinned one at all.
      for (const [method, route, ability] of OWN_ROUTES) {
        // Fresh tokens per route: half of these revoke sessions, so a single pair would be dead by
        // the second iteration and every later assertion would read 401 instead of what it meant to.
        const refused = await fetch(`${ROOT}${route}`, { method, ...authed(await pinnedToken('ci.deploy')) })
        expect(refused.status, `${method} ${route} with a pinned token`).toBe(403)
        expect(refused.headers.get('www-authenticate') ?? '').toContain(`scope="${ability}"`)

        // A human session is never gated: it must not 403 (422/423 are fine — those are the route's
        // own validation or step-up, which is the point: it got PAST the ability gate).
        const allowed = await fetch(`${ROOT}${route}`, { method, ...authed(await pinnedToken()) })
        expect(allowed.status, `${method} ${route} with a derived token`).not.toBe(403)
      }
    })

    it('lets a pinned token through once it pins the ability itself', async () => {
      const token = await pinnedToken('ci.deploy,lukk.sessions')

      expect((await fetch(`${ROOT}/auth/sessions/others`, { method: 'DELETE', ...authed(token) })).status).toBe(204)
      // ...but only the one it asked for.
      expect((await fetch(`${ROOT}/auth/passkeys`, authed(token))).status).toBe(403)
    })

    it('never gates a pinned token out of ending or renewing its own session', async () => {
      // Otherwise pinning a grant would make a token unusable rather than restricted.
      const token = await pinnedToken('ci.deploy')

      expect((await fetch(`${ROOT}/auth/logout`, { method: 'POST', ...authed(token) })).status).toBeLessThan(300)
    })

    it('publishes an empty ability list, distinctly from publishing none', async () => {
      // The rule the whole absent-vs-empty design rests on, and the suite never asserted it live.
      // A token pinned to NOTHING is the most restricted the API can issue: it must report `[]`
      // ("in use, granted nothing"), never an absent key, which a client reads as "no abilities
      // here" and renders the full privileged UI for.
      const token = await pinnedToken('')
      const user = shapeUser(await (await fetch(`${ROOT}/user`, authed(token))).json())

      expect(user?.abilities).toEqual([])
      expect(user?.token_pinned).toBe(true)
      expect((await fetch(`${ROOT}/auth/sessions`, { method: 'DELETE', ...authed(token) })).status).toBe(403)
    })

    it('exports exactly the fields the client type declares', async () => {
      // Asserted as an exhaustive key set, not with `toHaveProperty`: a field the server ADDS should
      // fail here too, and a field it stops emitting is how `AccountExport.sessions[].guard` came to
      // declare something no endpoint ever returned.
      const token = await pinnedToken('lukk.account,lukk.account.delete')
      const confirmation = await (await fetch(`${ROOT}/auth/confirm-password`, {
        method: 'POST',
        headers: { ...authed(token).headers, 'content-type': 'application/json' },
        body: JSON.stringify({ password: PASSWORD }),
      })).json() as { confirmation_token: string }

      const stepped = { headers: { ...authed(token).headers, 'X-Lukk-Confirmation': confirmation.confirmation_token } }
      const exported = await (await fetch(`${ROOT}/auth/account/export`, stepped)).json() as AccountExport

      expect(Object.keys(exported).sort()).toEqual(['account', 'generated_at', 'passkeys', 'sessions', 'two_factor'])
      expect(Object.keys(exported.sessions[0]!).sort())
        .toEqual(['created_at', 'expires_at', 'last_rotated_at', 'revoked_at', 'session'])
      expect(Object.keys(exported.two_factor).sort()).toEqual(['confirmed_at', 'enabled'])
    })

    it('erases a disposable account end to end', async () => {
      // The three properties `DeleteAccount`'s ordering exists to guarantee, none of which any
      // client-side test verified: the call succeeds, the access token is dead immediately, and the
      // identity can no longer log in.
      const who = await (await fetch(`${ROOT}/conformance/ephemeral-user`)).json() as { email: string, password: string }
      const { lukk, state } = client()
      const result = await lukk.login({ email: who.email, password: who.password })
      if (isTwoFactorChallenge(result)) throw new Error('unexpected 2FA challenge')

      const confirmation = await lukk.confirmPassword(who.password)
      state.confirmation = confirmation.confirmation_token

      await expect(lukk.deleteAccount()).resolves.toBeUndefined()

      expect((await fetch(`${ROOT}/user`, authed(state.access!))).status).toBe(401)
      await expect(lukk.login({ email: who.email, password: who.password })).rejects.toBeTruthy()
    })

    it('carries the grant through a refresh', async () => {
      // Abilities are re-derived on every mint, so a rotation is where a wiring mistake would
      // silently drop the `scope` claim and quietly widen or narrow the token.
      const { lukk, state } = client()
      await lukk.login({ email: USER, password: PASSWORD })
      await lukk.refreshTokens(COOKIE_MODE ? undefined : state.refresh)

      const res = await fetch(`${ROOT}/gated/prefix`, {
        headers: { accept: 'application/json', authorization: `Bearer ${state.access}` },
      })

      expect(res.status).toBe(200)
      expect(can(['orders.read', 'billing.*'], 'billing.view')).toBe(true)
    })
  })

  describe.runIf(!FEAT_ABILITIES)('a server that does not use abilities', () => {
    it('omits the key entirely, rather than publishing an empty list', async () => {
      // The rule the whole absent-vs-empty design rests on, and it can only be asserted HERE —
      // against a server with the feature off. `[]` would tell a client "in use, granted nothing"
      // and blank the UI of every app that upgraded without opting in.
      const { lukk, state } = client()
      const result = await lukk.login({ email: USER, password: PASSWORD })
      if (isTwoFactorChallenge(result)) throw new Error('unexpected 2FA challenge')

      const user = shapeUser(await (await fetch(`${ROOT}/user`, {
        headers: { accept: 'application/json', authorization: `Bearer ${state.access}` },
      })).json())

      expect(user).not.toBeNull()
      expect(user).not.toHaveProperty('abilities')
      expect(can(user?.abilities, 'anything.at.all')).toBe(true)
    })
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

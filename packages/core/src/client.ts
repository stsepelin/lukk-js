import type {
  AccountExport,
  ChangePasswordInput,
  ConfirmationToken,
  LoginInput,
  LoginResult,
  LukkError,
  PasskeyLoginOptions,
  PasskeySummary,
  PublicKeyCredentialCreationOptionsJSON,
  RecoveryCodeCount,
  RegisterInput,
  RegisterResult,
  ResetPasswordInput,
  TokenPair,
  TwoFactorEnrollment,
  TwoFactorInput,
} from './types'

/**
 * Hooks the framework binding wires up. The core is transport- and
 * storage-agnostic: it knows how to *speak* to lukk and how to refresh on a
 * 401, but where tokens live (memory, sealed cookie, Nitro session) is the
 * binding's job.
 */
export interface LukkClientHooks {
  /** lukk base URL incl. the route prefix, e.g. `https://api.example.com/auth`. */
  baseURL: string
  fetch?: typeof globalThis.fetch
  /** Bearer token to attach (omit in cookie/BFF mode where the proxy adds it). */
  getAccessToken?: () => string | null | Promise<string | null>
  /** Step-up token for `X-Lukk-Confirmation`, when one has been earned. */
  getConfirmationToken?: () => string | null | Promise<string | null>
  /** Obtain a fresh pair when a request 401s. Return null if not refreshable. */
  refresh?: () => Promise<TokenPair | null>
  /** Persist a freshly-minted pair (login / 2FA / passkey login / restore). */
  onTokens?: (pair: TokenPair) => void | Promise<void>
  /** Refresh failed → the session is gone. */
  onUnauthenticated?: () => void | Promise<void>
  /** Header carrying the confirmation token (default `X-Lukk-Confirmation`). */
  confirmationHeader?: string
}

/** Collapse concurrent calls into a single in-flight promise. */
export function singleFlight<T>(fn: () => Promise<T>): () => Promise<T> {
  let inflight: Promise<T> | null = null
  return () => (inflight ??= Promise.resolve(fn()).finally(() => { inflight = null }))
}

export function isTokenPair(value: unknown): value is TokenPair {
  return typeof value === 'object' && value !== null
    && typeof (value as TokenPair).access_token === 'string'
}

export type LukkClient = ReturnType<typeof createLukkClient>

export function createLukkClient(hooks: LukkClientHooks) {
  const doFetch = hooks.fetch ?? globalThis.fetch
  const confirmHeader = hooks.confirmationHeader ?? 'X-Lukk-Confirmation'
  // Single-flight the refresh so a burst of 401s triggers exactly one refresh.
  const refreshOnce = hooks.refresh ? singleFlight(hooks.refresh) : null

  async function request<T>(path: string, init: RequestInit = {}, allowRetry = true): Promise<T> {
    const headers = new Headers(init.headers)
    headers.set('Accept', 'application/json')
    if (init.body != null && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')

    // Only attach credentials to a same-origin-as-baseURL target — never leak the
    // bearer / confirmation token (or cookies) to an absolute, cross-origin URL.
    const sameOrigin = isSameOrigin(hooks.baseURL, path)
    if (sameOrigin) {
      const token = await hooks.getAccessToken?.()
      if (token) headers.set('Authorization', `Bearer ${token}`)
      const confirmation = await hooks.getConfirmationToken?.()
      if (confirmation) headers.set(confirmHeader, confirmation)
    }

    const res = await doFetch(joinURL(hooks.baseURL, path), {
      ...init,
      // `credentials` and `redirect` sit AFTER `...init` so a caller can't override the origin-scoped
      // credentials mode or re-enable redirect following.
      // Origin-scoped: attach cookies only to a same-origin-as-baseURL target (see `sameOrigin` above).
      credentials: sameOrigin ? 'include' : 'same-origin',
      // Never auto-follow a redirect: on a server/undici fetch a cross-origin 3xx would forward
      // the custom `X-Lukk-Confirmation` header to the target (the bearer is stripped, this isn't).
      // A 3xx from an auth route is anomalous — surface it as an error instead of chasing it.
      redirect: 'manual',
      headers,
    })

    if (res.status === 401 && allowRetry && refreshOnce) {
      let pair: TokenPair | null
      // A throwing refresh hook means "not refreshable" — honor the documented contract.
      try { pair = await refreshOnce() }
      catch { pair = null }
      // Gated on the shape, like every other sink (`commit`). The refresh path checked only for
      // truthiness, so any 2xx body from /refresh reached the binding's storage hook unvalidated —
      // and a binding that persists the whole object would store attacker-shaped data.
      if (isTokenPair(pair)) {
        await hooks.onTokens?.(pair)
        return request<T>(path, init, false) // retry once with the new token
      }
      await hooks.onUnauthenticated?.()
    }

    if (!res.ok) throw await toLukkError(res)
    return parseBody<T>(res)
  }

  const json = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) })

  /** Persist any token pair a call produced (login is exempt when it 2FA-challenges). */
  async function commit<T>(result: T): Promise<T> {
    if (isTokenPair(result)) await hooks.onTokens?.(result)
    return result
  }

  return {
    request,

    // --- session ---
    /** Create an account and (unless verification blocks it) start a session — like login. */
    register: (input: RegisterInput) => request<RegisterResult>('/register', json(input)).then(commit),
    login: (c: LoginInput) => request<LoginResult>('/login', json(c)).then(commit),
    twoFactorChallenge: (i: TwoFactorInput) => request<TokenPair>('/two-factor-challenge', json(i)).then(commit),
    /** Direct mode passes the refresh token; cookie/BFF mode relies on the cookie. */
    refreshTokens: (refresh_token?: string) => request<TokenPair>('/refresh', json(refresh_token ? { refresh_token } : {}), false),
    /** Silently restore a session on app load (returns null when there's no valid refresh). */
    restore: () => request<TokenPair>('/refresh', json({}), false).then(commit).catch(() => null as TokenPair | null),
    logout: () => request<void>('/logout', { method: 'POST' }),
    revokeAllSessions: () => request<void>('/sessions', { method: 'DELETE' }),
    revokeOtherSessions: () => request<void>('/sessions/others', { method: 'DELETE' }),

    // --- email verification ---
    /** Resend the email-verification link to the authenticated user (a no-op if already verified). */
    sendEmailVerification: () => request<void>('/email/verification-notification', { method: 'POST' }),

    // --- password reset (public; pairs with lukk's features.password_reset) ---
    /** Request a password-reset link be emailed. Always resolves 200 (no user enumeration). */
    forgotPassword: (email: string) => request<void>('/forgot-password', json({ email })),
    /** Complete a reset with the token + email from the emailed link and the new password. */
    resetPassword: (input: ResetPasswordInput) => request<void>('/reset-password', json(input)),
    /** Change the password of the SIGNED-IN user. Revokes every other session upstream; this one
     *  survives, so no re-login and no token change here. */
    changePassword: (input: ChangePasswordInput) => request<void>('/password', json(input)),

    // --- the account itself (behind step-up) ---
    /**
     * Erase the account (GDPR Art. 17). **Irreversible**, and it ends the session that called it —
     * every token is revoked server-side before the row is deleted, so treat the resolved promise as
     * "you are now logged out and the account is gone".
     */
    deleteAccount: () => request<void>('/account', { method: 'DELETE' }),
    /**
     * The personal data lukk holds (Art. 15 / 20): sessions, passkeys, whether two-factor is on.
     *
     * The **auth slice only** — lukk knows nothing about your domain data, so serving this alone as
     * a subject-access response would under-disclose. Append your own before you hand it over.
     * Credential material is deliberately absent: a TOTP secret and recovery codes are secrets whose
     * only use is authenticating as the subject, not data they benefit from receiving.
     */
    exportAccount: () => request<AccountExport>('/account/export'),

    // --- step-up confirmation ---
    confirmPassword: (password: string) => request<ConfirmationToken>('/confirm-password', json({ password })),
    confirmPasskey: (ceremony_id: string, credential: unknown) => request<ConfirmationToken>('/confirm-passkey', json({ ceremony_id, credential })),

    // --- 2FA management (behind step-up) ---
    enableTwoFactor: () => request<TwoFactorEnrollment>('/two-factor', { method: 'POST' }),
    confirmTwoFactor: (code: string) => request<void>('/two-factor/confirm', json({ code })),
    disableTwoFactor: () => request<void>('/two-factor', { method: 'DELETE' }),
    recoveryCodeCount: () => request<RecoveryCodeCount>('/two-factor/recovery-codes'),
    regenerateRecoveryCodes: () => request<{ recovery_codes: string[] }>('/two-factor/recovery-codes', { method: 'POST' }),

    // --- passkeys (browser ceremony lives in the binding; see ./webauthn) ---
    passkeyRegistrationOptions: () => request<PublicKeyCredentialCreationOptionsJSON>('/passkeys/registration-options', { method: 'POST' }),
    registerPasskey: (credential: unknown, name?: string) => request<void>('/passkeys', json({ credential, name })),
    passkeyLoginOptions: () => request<PasskeyLoginOptions>('/passkeys/login-options', { method: 'POST' }),
    loginWithPasskey: (ceremony_id: string, credential: unknown) => request<TokenPair>('/passkeys/login', json({ ceremony_id, credential })).then(commit),
    listPasskeys: () => request<{ passkeys: PasskeySummary[] }>('/passkeys'),
    deletePasskey: (id: string) => request<void>(`/passkeys/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  }
}

/** Absolute URLs (e.g. the app's user endpoint) pass through untouched. */
function joinURL(base: string, path: string): string {
  if (/^https?:\/\//i.test(path)) return path

  // Strip EVERY leading slash and backslash, not one. With an empty or `/` base, leaving a second
  // one produced a protocol-relative URL — `//evil.com/x` — which resolves to a foreign origin
  // while `isSameOrigin` had already classified it as relative and attached credentials.
  return `${base.replace(/\/$/, '')}/${path.replace(/^[/\\]+/, '')}`
}

/**
 * Is the request target the same origin as `baseURL`? A relative `path` is always
 * same-origin (it joins onto the base). An absolute `path` only counts when its
 * origin matches an absolute base — otherwise we refuse to attach credentials.
 * Exported so lukk-nuxt's `useLukkFetch` reuses the exact same guard.
 */
export function isSameOrigin(base: string, path: string): boolean {
  // Canonicalise the way the WHATWG URL parser will, BEFORE deciding. A bare `^https?://` test is
  // far stricter than the parser: the parser strips leading C0 controls and spaces, and treats `\`
  // as `/` for special schemes. So ` https://evil.com`, `\thttps://evil.com` and `https:/\evil.com`
  // all resolve to `https://evil.com` while reading as "relative" to the regex — and a relative
  // path is exactly what this function green-lights for credentials.
  // eslint-disable-next-line no-control-regex -- C0 controls are exactly what the parser strips
  const candidate = path.replace(/^[\u0000-\u0020]+/, '').replace(/\\/g, '/')

  // No scheme, but an authority follows: protocol-relative, so always a foreign origin.
  if (candidate.startsWith('//')) return false

  // Anything else carrying a scheme must be http(s) AND match the base's origin. A non-http scheme
  // (`javascript:`, `data:`, `blob:`) is never same-origin, whatever the base.
  if (/^[a-z][a-z0-9+.-]*:/i.test(candidate)) {
    if (!/^https?:/i.test(candidate) || !/^https?:\/\//i.test(base)) return false
    try { return new URL(candidate).origin === new URL(base).origin }
    catch { return false }
  }

  return true
}

async function parseBody<T>(res: Response): Promise<T> {
  const text = await res.text()
  if (!text) return undefined as T
  try { return JSON.parse(text) as T }
  catch { throw { status: res.status, message: 'lukk: invalid JSON in response body' } satisfies LukkError }
}

/**
 * Build a {@link LukkError} from a status + an already-parsed Laravel error body
 * (`{ message, errors }`). Exported so lukk-nuxt shapes app-API errors identically.
 */
export function lukkError(status: number, statusText: string, body: { message?: string, errors?: Record<string, string[]> } | null | undefined): LukkError {
  const b = body ?? {}
  return { status, message: b.message ?? statusText, ...(b.errors ? { errors: b.errors } : {}) }
}

async function toLukkError(res: Response): Promise<LukkError> {
  let body: { message?: string, errors?: Record<string, string[]> } = {}
  try { body = JSON.parse(await res.text()) }
  catch { /* non-JSON error body */ }
  return lukkError(res.status, res.statusText, body)
}

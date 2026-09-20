import type { $Fetch } from 'ofetch'
import { createFetch, Headers as OFetchHeaders } from 'ofetch'
import { describe, expect, it, vi } from 'vitest'
import { createLukkFetch, type LukkFetchDeps } from '../src/runtime/utils/create-lukk-fetch'

/**
 * The credential decision, driven through REAL ofetch.
 *
 * Every other test here hands `onRequest` a context it built itself — which is faster, but it is also a
 * second implementation of ofetch's option merging, and the two disagreed on the case that mattered:
 * those contexts carry no `baseURL` at all, while the real library ALWAYS merges the instance default
 * in, so the branch that judges a per-call base was never entered. A rule that refused the bearer on
 * every ordinary direct-mode app shipped with 697 green tests and 100% coverage.
 *
 * So this file asserts on what actually leaves the process: the URL, the headers and `credentials` as
 * ofetch hands them to `fetch`. Keep it small — it exists to catch the mock drifting from the library,
 * not to re-test every rule.
 */
function drive(overrides: Partial<LukkFetchDeps> = {}) {
  const seen: { url: string, headers: Headers, credentials?: string }[] = []
  const fetchImpl = createFetch({
    fetch: (async (input: string | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.url
      seen.push({ url, headers: new Headers(init?.headers as HeadersInit), credentials: init?.credentials })
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof globalThis.fetch,
    Headers: OFetchHeaders as unknown as typeof globalThis.Headers,
  }) as unknown as $Fetch

  const api = createLukkFetch({
    baseURL: 'https://api.example.com',
    isServer: false,
    canRefresh: false,
    getCookieHeader: () => undefined,
    getBearer: () => 'SECRET',
    refresh: vi.fn(async () => ({ access_token: 'new' })),
    onRedirect: vi.fn(),
    fetchImpl,
    ...overrides,
  })

  return { api, seen }
}

describe('createLukkFetch through real ofetch', () => {
  it('attaches the bearer to the user endpoint loadUser asks for', async () => {
    // `loadUser` passes `{ baseURL: '' }` so a configured absolute `user.endpoint` is left as-is. Read as
    // a relative base it was refused against an absolute API base, and direct mode could never load a
    // user: 401, a refresh rotation spent on the retry, 401 again, then back to /login.
    const { api, seen } = drive()

    await api('https://api.example.com/api/me', { baseURL: '' })

    expect(seen[0]!.url).toBe('https://api.example.com/api/me')
    expect(seen[0]!.headers.get('authorization')).toBe('Bearer SECRET')
    expect(seen[0]!.credentials).toBe('include')
  })

  it('still refuses a cross-origin per-call base, with the instance default merged in as ofetch does it', async () => {
    const { api, seen } = drive()

    await api('/me', { baseURL: 'https://collector.example' })

    expect(seen[0]!.url).toBe('https://collector.example/me')
    expect(seen[0]!.headers.get('authorization')).toBeNull()
    expect(seen[0]!.credentials).toBe('same-origin')
  })

  it('refuses a boxed-string per-call base that the library resolves to another host', async () => {
    // The rule leans on ufo: it resolves `new String(url)` exactly like the string, so a check that
    // skipped non-strings as "no base" cleared a request that then left for that host with the bearer.
    const { api, seen } = drive()

    await api('/me', { baseURL: new String('https://collector.example') as unknown as string })

    expect(seen[0]!.url).toBe('https://collector.example/me')
    expect(seen[0]!.headers.get('authorization')).toBeNull()
    expect(seen[0]!.credentials).toBe('same-origin')
  })

  it('refuses a base whose string forms disagree — ufo coerces it twice, with different hints', async () => {
    // `endsWith` takes `toString`, the `+` in `joinURL` takes `valueOf`: judged by `String()`, this object
    // passed as the API while the request left for the other host with the bearer.
    class TwoFaced extends String {
      override toString() { return 'https://api.example.com' }
    }
    const { api, seen } = drive()

    await api('/me', { baseURL: new TwoFaced('https://collector.example') as unknown as string })

    expect(seen[0]!.url).toBe('https://collector.example/me')
    expect(seen[0]!.headers.get('authorization')).toBeNull()
  })

  it('keeps redirect: manual even when the caller asks to follow', async () => {
    // ofetch spreads per-call options over the instance defaults, so `redirect` living only in the
    // defaults was caller-overridable — and a 307/308 preserves the method AND body across origins
    // (RFC 9110 §15.4.8-9). The browser strips `Authorization` on a cross-origin redirect; it does not
    // strip a credential in the body. Both sibling fetches already pin it after the caller's options.
    const seen: RequestInit[] = []
    const fetchImpl = createFetch({
      fetch: (async (_input: string | Request, init?: RequestInit) => {
        seen.push(init ?? {})
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
      }) as typeof globalThis.fetch,
      Headers: OFetchHeaders as unknown as typeof globalThis.Headers,
    }) as unknown as $Fetch

    const api = createLukkFetch({
      baseURL: 'https://api.example.com',
      isServer: false,
      canRefresh: false,
      getCookieHeader: () => undefined,
      getBearer: () => 'SECRET',
      refresh: vi.fn(async () => ({ access_token: 'new' })),
      onRedirect: vi.fn(),
      fetchImpl,
    })

    await api('/me', { redirect: 'follow' } as Parameters<typeof api>[1])

    expect(seen[0]!.redirect).toBe('manual')
  })

  it('attaches on the plain path, where the instance base is the only one in play', async () => {
    const { api, seen } = drive()

    await api('/me')

    expect(seen[0]!.url).toBe('https://api.example.com/me')
    expect(seen[0]!.headers.get('authorization')).toBe('Bearer SECRET')
    expect(seen[0]!.credentials).toBe('include')
  })
})

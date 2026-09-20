import { afterEach, describe, expect, it, vi } from 'vitest'
import { refreshOnce } from '../src/runtime/server/utils/refresh'

afterEach(() => vi.restoreAllMocks())

describe('refreshOnce with an unusable baseURL', () => {
  it('returns null (not refreshable) instead of fetching a null target', async () => {
    // The module rejects such a baseURL at build, so this is only reachable via a runtime override
    // (NUXT_LUKK_BASE_URL). It must fail as "not refreshable" — never as an unreadable fetch throw,
    // and never by hitting the network with an unresolved target.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('fetch must not be called with an unresolved target')
    })

    const result = await refreshOnce({ id: 'sid', data: { refresh: 'rt' } }, 'undefined/auth')

    expect(result.pair).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(String(error.mock.calls[0]![0])).toContain('undefined/auth')
  })

  it('masks credentials and reports once per value, like the proxy path', async () => {
    // An UNUSABLE base can still carry credentials — this one fails on the port, not the userinfo —
    // and this path runs per SSR render and per app-API request with an aged token, so logging the
    // raw value on every attempt would spill credentials into server logs repeatedly.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const base = `https://user:hunter2@api.example.com:99999/auth-${Math.random()}`

    for (let i = 0; i < 4; i++) {
      expect((await refreshOnce({ id: 'sid', data: { refresh: 'rt' } }, base)).pair).toBeNull()
    }

    expect(error).toHaveBeenCalledOnce()
    expect(String(error.mock.calls[0]![0])).not.toContain('hunter2')
    expect(String(error.mock.calls[0]![0])).toContain('***@api.example.com')
  })
})

describe('refreshOnce when lukk can\'t be reached', () => {
  it('never follows an upstream redirect — it would re-send the rotating token to the redirect host', async () => {
    // Pinned on the proxy fetch and the revoke fetch, but not on the ONE fetch that actually carries a
    // rotating refresh token: a 307/308 preserves the method and body, so a followed redirect hands the
    // credential to whatever host lukk (or something in front of it) names. CWE-918/200.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_in: 900 }), { status: 200, headers: { 'content-type': 'application/json' } }),
    )

    await refreshOnce({ id: 'sid', data: { refresh: 'rt' } }, 'https://api.example.com/auth')

    expect(fetchSpy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ redirect: 'manual' }))
  })

  it('reports it retryable instead of throwing out of the handler as a 500', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'))

    const result = await refreshOnce({ id: `h3-${Math.random()}`, data: { refresh: 'rt', sid: `s-${Math.random()}` } }, 'https://lukk/auth')

    expect(result).toEqual({ pair: null, retryable: true })
  })
})

describe('refreshOnce single-flight identity', () => {
  it('keys on the session\'s own sid, so a new session never joins a refresh for the one it replaced', async () => {
    // A sign-in re-seals the NEW session under the OLD h3 id. Keyed on that id, a refresh for the new
    // session joined one still out for the old — and sealed the old session's tokens under the new one.
    let answer!: (r: Response) => void
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => new Promise((resolve) => { answer = resolve }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'B2' }), { status: 200 }))
    const h3id = `h3-${Math.random()}`

    const old = refreshOnce({ id: h3id, data: { refresh: 'rA', sid: 'session-A' } }, 'https://lukk/auth')
    const replacement = await refreshOnce({ id: h3id, data: { refresh: 'rB', sid: 'session-B' } }, 'https://lukk/auth')

    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(replacement.pair?.access).toBe('B2')
    answer(new Response(JSON.stringify({ access_token: 'A2' }), { status: 200 }))
    expect((await old).pair?.access).toBe('A2')
  })

  it('collapses refreshes of one session across separately bundled copies of the module', async () => {
    // SSR hydration runs from the Nuxt app's server bundle, the proxies from Nitro's: each has its own
    // copy of this module, and module-level state never saw the other's refresh in flight.
    let answer!: (r: Response) => void
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise((resolve) => { answer = resolve }))
    vi.resetModules()
    const copy = await import('../src/runtime/server/utils/refresh')
    const session = { id: `h3-${Math.random()}`, data: { refresh: 'rA', sid: `s-${Math.random()}` } }

    const fromProxy = refreshOnce(session, 'https://lukk/auth')
    const fromRender = copy.refreshOnce(session, 'https://lukk/auth')
    answer(new Response(JSON.stringify({ access_token: 'A2' }), { status: 200 }))

    expect((await fromRender).pair?.access).toBe('A2')
    expect(await fromProxy).toBe(await fromRender)
    expect(fetchSpy).toHaveBeenCalledOnce()
  })

  it('still collapses concurrent refreshes of the SAME session into one', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ access_token: 'A2' }), { status: 200 }))
    const session = { id: `h3-${Math.random()}`, data: { refresh: 'rA', sid: `s-${Math.random()}` } }

    await Promise.all([refreshOnce(session, 'https://lukk/auth'), refreshOnce(session, 'https://lukk/auth')])

    expect(fetchSpy).toHaveBeenCalledOnce()
  })
})

describe('refreshOnce client identity', () => {
  const ok = () => new Response(JSON.stringify({ access_token: 'a', refresh_token: 'r2' }), { status: 200 })

  it('forwards the visitor IP so lukk\'s /refresh throttle keys on them, not on this server', async () => {
    // `lukk-refresh` is `->by($request->ip())` at 30/60s. In BFF mode every proxied 401 and every
    // SSR hydration refreshes through here, so without the visitor's address they all share one
    // bucket and a busy deployment throttles itself.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok())

    await refreshOnce({ id: `s-${Math.random()}`, data: { refresh: 'rt' } }, 'https://lukk/auth', '198.51.100.23')

    expect(fetchSpy.mock.calls[0]![1]!.headers).toMatchObject({ 'X-Forwarded-For': '198.51.100.23' })
  })

  it('sends no X-Forwarded-For when no visitor address is known', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok())

    await refreshOnce({ id: `s-${Math.random()}`, data: { refresh: 'rt' } }, 'https://lukk/auth')

    expect((fetchSpy.mock.calls[0]![1]!.headers as Record<string, string>)['X-Forwarded-For']).toBeUndefined()
  })
})

describe('refreshOnce outcome', () => {
  const answer = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status })

  it('POSTs the refresh token as JSON and asks for JSON back', async () => {
    // lukk's route is POST-only, and its JSON errors depend on `Accept` — without it a validation
    // failure renders as a redirect, which this client refuses to follow and would read as an outage.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(answer(200, { access_token: 'a' }))

    await refreshOnce({ id: `s-${Math.random()}`, data: { refresh: 'rt' } }, 'https://lukk/auth')

    const init = fetchSpy.mock.calls[0]![1]!
    expect(init.method).toBe('POST')
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json', 'Accept': 'application/json' })
    expect(JSON.parse(String(init.body))).toEqual({ refresh_token: 'rt' })
  })

  it('hands back the rotated pair as final — the token it sent is spent', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(answer(200, { access_token: 'a2', refresh_token: 'r2', expires_in: 900 }))

    expect(await refreshOnce({ id: `s-${Math.random()}`, data: { refresh: 'rt' } }, 'https://lukk/auth'))
      .toEqual({ pair: { access: 'a2', refresh: 'r2' }, expiresIn: 900, retryable: false })
  })

  it.each([401, 403])('ends the session on a %i — lukk rejected the token itself', async (status) => {
    // Retrying a revoked or reused token is not harmless: every attempt past grace is another
    // reuse signal, and the session never ends while the caller keeps it.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(answer(status))

    expect(await refreshOnce({ id: `s-${Math.random()}`, data: { refresh: 'rt' } }, 'https://lukk/auth'))
      .toEqual({ pair: null, retryable: false })
  })

  it.each([429, 503])('keeps the session on a %i — the token was never consumed', async (status) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(answer(status))

    expect(await refreshOnce({ id: `s-${Math.random()}`, data: { refresh: 'rt' } }, 'https://lukk/auth'))
      .toEqual({ pair: null, retryable: true })
  })

  it('keeps the session when the baseURL is unusable, and names the setting at fault', async () => {
    // A deployment fault, not a dead session: the token was never sent.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const base = `undefined/auth-${Math.random()}`

    expect(await refreshOnce({ id: `s-${Math.random()}`, data: { refresh: 'rt' } }, base)).toEqual({ pair: null, retryable: true })
    expect(String(error.mock.calls[0]![0])).toContain('lukk `baseURL`')
  })

  it('never collapses two sessions that have no identity', async () => {
    // Without a key, joining an in-flight refresh would hand one visitor another visitor's tokens.
    let first!: (r: Response) => void
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => new Promise((resolve) => { first = resolve }))
      .mockResolvedValueOnce(answer(200, { access_token: 'B2' }))

    const a = refreshOnce({ data: { refresh: 'rA' } }, 'https://lukk/auth')
    const b = await refreshOnce({ data: { refresh: 'rB' } }, 'https://lukk/auth')

    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(b.pair?.access).toBe('B2')
    first(answer(200, { access_token: 'A2' }))
    expect((await a).pair?.access).toBe('A2')
  })
})

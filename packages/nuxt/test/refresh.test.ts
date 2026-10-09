import { afterEach, describe, expect, it, vi } from 'vitest'
import { refreshOnce } from '../src/runtime/server/refresh'

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

  it('never abandons a rotation in flight, but bounds how long each caller waits on it', async () => {
    // A refresh is the one call whose loss cannot be retried. Once lukk has the token it rotates it, and
    // cutting the connection does not undo that — so the fetch itself is never aborted. A CALLER is not
    // held past the deadline, though: it answers "couldn't tell, retry shortly", and its retry, still
    // carrying the old token, joins the very same call rather than replaying that token to lukk.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => new Promise((resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))
      setTimeout(() => resolve(new Response(JSON.stringify({ access_token: 'slow-at', refresh_token: 'slow-rt', expires_in: 900 }), { status: 200 })), 20_000)
    }))
    const session = { id: 'slow', data: { refresh: 'rt', sid: `slow-${Math.random()}` } }

    const first = refreshOnce(session, 'https://api.example.com/auth')
    await vi.advanceTimersByTimeAsync(15_000)
    await expect(first).resolves.toEqual({ pair: null, retryable: true, retryAfter: 5 })

    const retry = refreshOnce(session, 'https://api.example.com/auth')
    await vi.advanceTimersByTimeAsync(5_000)

    await expect(retry).resolves.toEqual({ pair: { access: 'slow-at', refresh: 'slow-rt' }, expiresIn: 900, retryable: false })
    expect(fetchSpy).toHaveBeenCalledOnce()
    vi.useRealTimers()
  })

  it('bounds the wait of a refresh with no session identity too', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {}))

    const result = refreshOnce({ data: { refresh: 'rt' } }, 'https://api.example.com/auth')
    await vi.advanceTimersByTimeAsync(15_000)

    await expect(result).resolves.toEqual({ pair: null, retryable: true, retryAfter: 5 })
    vi.useRealTimers()
  })

  it('stops sharing a refresh that never settles after five minutes, so a hung connection cannot wedge the session', async () => {
    // On a runtime with no transport timeout of its own, a connection that hangs forever kept the session's
    // single-flight entry forever, and every later refresh for it joined a call that would never answer.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {}))
    const session = { id: 'hung', data: { refresh: 'rt', sid: `hung-${Math.random()}` } }

    void refreshOnce(session, 'https://api.example.com/auth')
    await vi.advanceTimersByTimeAsync(5 * 60_000 - 1)
    void refreshOnce(session, 'https://api.example.com/auth')
    expect(fetchSpy).toHaveBeenCalledOnce() // still shared just before the backstop

    await vi.advanceTimersByTimeAsync(1)
    void refreshOnce(session, 'https://api.example.com/auth')
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })

  it('never lets a dropped refresh that settles late evict the one that replaced it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const answers: ((r: Response) => void)[] = []
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise((resolve) => { answers.push(resolve) }))
    const session = { id: 'late', data: { refresh: 'rt', sid: `late-${Math.random()}` } }

    void refreshOnce(session, 'https://api.example.com/auth')
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    void refreshOnce(session, 'https://api.example.com/auth') // the replacement, now in flight
    answers[0]!(new Response('{}', { status: 503 })) // the dropped one finally answers
    await vi.advanceTimersByTimeAsync(0)

    void refreshOnce(session, 'https://api.example.com/auth')
    expect(fetchSpy).toHaveBeenCalledTimes(2) // joined the replacement, not a third call
    vi.useRealTimers()
  })

  it('leaves no timer behind once a refresh settles', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ access_token: 'a' }), { status: 200 }))

    await refreshOnce({ id: 'quick', data: { refresh: 'rt', sid: `quick-${Math.random()}` } }, 'https://api.example.com/auth')

    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
  })

  it('reports it retryable instead of throwing out of the handler as a 500', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'))

    const result = await refreshOnce({ id: `h3-${Math.random()}`, data: { refresh: 'rt', sid: `s-${Math.random()}` } }, 'https://lukk/auth')

    expect(result).toEqual({ pair: null, retryable: true })
  })
})

describe('a rotation that lands after every caller gave up', () => {
  const base = 'https://api.example.com/auth'
  const rotated = { access_token: 'late-at', refresh_token: 'late-rt', expires_in: 900 }
  const adopted = { pair: { access: 'late-at', refresh: 'late-rt' }, expiresIn: 900, retryable: false }

  /** One refresh lukk answers at `lagMs`, after the caller's 15 s wait has run out. */
  async function lateRotation(sid: string, lagMs = 20_000) {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise((resolve) => {
      setTimeout(() => resolve(new Response(JSON.stringify(rotated), { status: 200 })), lagMs)
    }))
    const first = refreshOnce({ id: 'h3', data: { refresh: 'old-rt', sid } }, base)
    await vi.advanceTimersByTimeAsync(15_000)
    await expect(first).resolves.toMatchObject({ pair: null, retryAfter: 5 })
    await vi.advanceTimersByTimeAsync(lagMs - 15_000)
    return fetchSpy
  }

  afterEach(() => vi.useRealTimers())

  it('is kept for the next request still presenting the token it consumed — the rotation is never lost', async () => {
    // Nobody was left to receive it: dropped, the session kept the consumed token, and its next refresh —
    // at the user's next action, long past lukk's grace window — was a replay, answered with a family revoke.
    const sid = `late-${Math.random()}`
    const fetchSpy = await lateRotation(sid)

    await vi.advanceTimersByTimeAsync(60_000) // the user comes back a minute later
    await expect(refreshOnce({ id: 'h3', data: { refresh: 'old-rt', sid } }, base)).resolves.toEqual(adopted)
    expect(fetchSpy).toHaveBeenCalledOnce() // adopted, never replayed
  })

  it('is adopted by every request still presenting that token, not only the first', async () => {
    // A page coming back fires several requests at once, all with the same old cookie. One adopting it
    // and the rest replaying the consumed token would revoke the family anyway.
    const sid = `late-${Math.random()}`
    const fetchSpy = await lateRotation(sid)

    const results = await Promise.all([1, 2, 3].map(() => refreshOnce({ id: 'h3', data: { refresh: 'old-rt', sid } }, base)))

    expect(results).toEqual([adopted, adopted, adopted])
    expect(fetchSpy).toHaveBeenCalledOnce()
  })

  it('is never handed to a request presenting a different token', async () => {
    const sid = `late-${Math.random()}`
    const fetchSpy = await lateRotation(sid)
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ access_token: 'own-at', refresh_token: 'own-rt' }), { status: 200 }))

    const other = await refreshOnce({ id: 'h3', data: { refresh: 'another-rt', sid } }, base)

    expect(other.pair).toEqual({ access: 'own-at', refresh: 'own-rt' })
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(JSON.parse(String(fetchSpy.mock.calls[1]![1]!.body))).toEqual({ refresh_token: 'another-rt' })
  })

  it('is never handed to another session presenting the same token', async () => {
    const fetchSpy = await lateRotation(`late-${Math.random()}`)
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ access_token: 'own-at' }), { status: 200 }))

    await refreshOnce({ id: 'h3', data: { refresh: 'old-rt', sid: `other-${Math.random()}` } }, base)

    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('is let go after ten minutes — past that the family is gone whatever happens', async () => {
    const sid = `late-${Math.random()}`
    const fetchSpy = await lateRotation(sid)
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ access_token: 'fresh-at' }), { status: 200 }))

    await vi.advanceTimersByTimeAsync(10 * 60_000 - 1)
    await expect(refreshOnce({ id: 'h3', data: { refresh: 'old-rt', sid } }, base)).resolves.toEqual(adopted)
    await vi.advanceTimersByTimeAsync(1)
    await refreshOnce({ id: 'h3', data: { refresh: 'old-rt', sid } }, base)

    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('lets an older outcome\'s expiry leave a newer one for the same session alone', async () => {
    const sid = `twice-${Math.random()}`
    const fetchSpy = await lateRotation(sid) // held from 20 s, until 10 min 20 s
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    // The session moved on to `late-rt`, and its own refresh landed late too — held from about 5 min 40 s.
    fetchSpy.mockImplementation(() => new Promise((resolve) => {
      setTimeout(() => resolve(new Response(JSON.stringify({ access_token: 'later-at', refresh_token: 'later-rt' }), { status: 200 })), 20_000)
    }))
    void refreshOnce({ id: 'h3', data: { refresh: 'late-rt', sid } }, base)
    await vi.advanceTimersByTimeAsync(20_000)
    await vi.advanceTimersByTimeAsync(5 * 60_000) // past the FIRST outcome's ten minutes

    await expect(refreshOnce({ id: 'h3', data: { refresh: 'late-rt', sid } }, base)).resolves.toMatchObject({ pair: { access: 'later-at' } })
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('is not kept when a caller was still there to receive it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise((resolve) => {
      setTimeout(() => resolve(new Response(JSON.stringify(rotated), { status: 200 })), 10_000)
    }))
    const sid = `delivered-${Math.random()}`

    const first = refreshOnce({ id: 'h3', data: { refresh: 'old-rt', sid } }, base)
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(first).resolves.toEqual(adopted)
    void refreshOnce({ id: 'h3', data: { refresh: 'old-rt', sid } }, base)

    expect(fetchSpy).toHaveBeenCalledTimes(2) // delivered once — nothing held for a second taker
  })

  it('is not kept when one of two callers gave up but the other still received it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise((resolve) => {
      setTimeout(() => resolve(new Response(JSON.stringify(rotated), { status: 200 })), 20_000)
    }))
    const sid = `half-${Math.random()}`

    void refreshOnce({ id: 'h3', data: { refresh: 'old-rt', sid } }, base)
    await vi.advanceTimersByTimeAsync(10_000)
    const second = refreshOnce({ id: 'h3', data: { refresh: 'old-rt', sid } }, base) // waits until 25 s
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(second).resolves.toEqual(adopted)
    void refreshOnce({ id: 'h3', data: { refresh: 'old-rt', sid } }, base)

    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('keeps nothing for a refresh lukk refused', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise((resolve) => {
      setTimeout(() => resolve(new Response('{}', { status: 503 })), 20_000)
    }))
    const sid = `refused-${Math.random()}`

    void refreshOnce({ id: 'h3', data: { refresh: 'old-rt', sid } }, base)
    await vi.advanceTimersByTimeAsync(20_000)
    void refreshOnce({ id: 'h3', data: { refresh: 'old-rt', sid } }, base)

    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })
})

describe('the timers a refresh sets', () => {
  it('never keep the process alive — a hung lukk must not hold up a shutdown', async () => {
    // Real timers: unref'd ones are not "active resources".
    const timers = () => process.getActiveResourcesInfo().filter(type => type === 'Timeout').length
    const before = timers()
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {}))

    void refreshOnce({ id: 'h3', data: { refresh: 'rt', sid: `hung-${Math.random()}` } }, 'https://api.example.com/auth')

    expect(timers()).toBe(before)
  })

  it('work where a timer is a plain number, as on workerd and Deno', async () => {
    vi.spyOn(globalThis, 'setTimeout').mockReturnValue(1 as never)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ access_token: 'a' }), { status: 200 }))

    await expect(refreshOnce({ id: 'h3', data: { refresh: 'rt', sid: `num-${Math.random()}` } }, 'https://api.example.com/auth')).resolves.toMatchObject({ pair: { access: 'a' } })
  })
})

describe('refreshOnce on an answer it does not read', () => {
  it('cancels the body of a refusal, so the connection is released', async () => {
    const cancel = vi.fn()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new ReadableStream({ cancel }), { status: 429 }))

    const result = await refreshOnce({ id: `s-${Math.random()}`, data: { refresh: 'rt' } }, 'https://lukk/auth')

    expect(result).toEqual({ pair: null, retryable: true })
    expect(cancel).toHaveBeenCalled()
  })

  it('copes with a refusal that has no body at all', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 401 }))

    await expect(refreshOnce({ id: `s-${Math.random()}`, data: { refresh: 'rt' } }, 'https://lukk/auth')).resolves.toEqual({ pair: null, retryable: false })
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
    const copy = await import('../src/runtime/server/refresh')
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

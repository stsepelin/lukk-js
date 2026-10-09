import { afterEach, describe, expect, it, vi } from 'vitest'
import { currentPair, refreshOnce } from '../src/runtime/server/refresh'
import { endSession, forgetEndedSessions, markSessionEnded, useSharedEndedSessions } from '../src/runtime/server/ended-sessions'
import { refreshJournals } from '../src/runtime/server/refresh-journal'

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

  it('leaves only its journal link\'s timer once a refresh settles, and that ends with the straggler window', async () => {
    // The caller received it, so it is journalled for the requests already out with the old cookie — for
    // thirty seconds, no longer. Nothing else outlives the refresh: not its wait, not its backstop.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ access_token: 'a', refresh_token: 'r' }), { status: 200 }))

      await refreshOnce({ id: 'quick', data: { refresh: 'rt', sid: `quick-${Math.random()}` } }, 'https://api.example.com/auth')

      expect(vi.getTimerCount()).toBe(1)
      await vi.advanceTimersByTimeAsync(30_000)
      expect(vi.getTimerCount()).toBe(0)
    }
    finally { vi.useRealTimers() }
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
  /** The outcome, its `expires_in` counted down from when lukk minted it — the refresh leaving at 0; 880 at 20 s. */
  const adopted = (expiresIn = 880) => ({ pair: { access: 'late-at', refresh: 'late-rt' }, expiresIn, retryable: false })

  /** One refresh lukk answers at `lagMs`, after the caller's 15 s wait has run out. */
  async function lateRotation(sid: string, lagMs = 20_000) {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise((resolve) => {
      setTimeout(() => resolve(new Response(JSON.stringify(rotated), { status: 200 })), lagMs)
    }))
    const first = refreshOnce({ id: 'h3', data: { refresh: 'old-rt', sid } }, base)
    await vi.advanceTimersByTimeAsync(15_000)
    await expect(first).resolves.toMatchObject({ pair: null, retryAfter: 5 })
    await vi.advanceTimersByTimeAsync(lagMs - 15_000)
    return fetchSpy
  }

  afterEach(() => { vi.useRealTimers(); forgetEndedSessions(); useSharedEndedSessions(undefined) })

  it('is kept for the next request still presenting the token it consumed — the rotation is never lost', async () => {
    // Nobody was left to receive it: dropped, the session kept the consumed token, and its next refresh —
    // at the user's next action, long past lukk's grace window — was a replay, answered with a family revoke.
    const sid = `late-${Math.random()}`
    const fetchSpy = await lateRotation(sid)

    await vi.advanceTimersByTimeAsync(60_500) // the user comes back a minute later
    // Its `expires_in` is what is LEFT of the access token, not what it was when lukk minted it.
    await expect(refreshOnce({ id: 'h3', data: { refresh: 'old-rt', sid } }, base)).resolves.toEqual(adopted(820))
    expect(fetchSpy).toHaveBeenCalledOnce() // adopted, never replayed
  })

  it('is adopted by every request still presenting that token, not only the first', async () => {
    // A page coming back fires several requests at once, all with the same old cookie. One adopting it
    // and the rest replaying the consumed token would revoke the family anyway.
    const sid = `late-${Math.random()}`
    const fetchSpy = await lateRotation(sid)

    const results = await Promise.all([1, 2, 3].map(() => refreshOnce({ id: 'h3', data: { refresh: 'old-rt', sid } }, base)))

    expect(results).toEqual([adopted(), adopted(), adopted()])
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

  it('is kept ten minutes for its first taker, and let go after', async () => {
    const kept = `late-${Math.random()}`
    const fetchSpy = await lateRotation(kept)
    await vi.advanceTimersByTimeAsync(10 * 60_000 - 1)
    await expect(refreshOnce({ id: 'h3', data: { refresh: 'old-rt', sid: kept } }, base)).resolves.toEqual(adopted(281))

    // Another session's, never taken: gone at ten minutes.
    const lapsed = `late-${Math.random()}`
    void refreshOnce({ id: 'h3', data: { refresh: 'old-rt', sid: lapsed } }, base)
    await vi.advanceTimersByTimeAsync(20_000)
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ access_token: 'fresh-at' }), { status: 200 }))
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    await refreshOnce({ id: 'h3', data: { refresh: 'old-rt', sid: lapsed } }, base)
    expect(fetchSpy).toHaveBeenCalledTimes(3)
  })

  it('once taken, stays only for the stragglers of that moment — thirty seconds', async () => {
    // Taken, the session has the pair. What still presents the consumed token after the burst of requests
    // that were already out is not this browser catching up — it is someone else holding an old cookie,
    // and lukk's reuse detection is the right answer to them.
    const sid = `burst-${Math.random()}`
    const fetchSpy = await lateRotation(sid)
    await vi.advanceTimersByTimeAsync(60_000)
    await expect(refreshOnce({ id: 'h3', data: { refresh: 'old-rt', sid } }, base)).resolves.toEqual(adopted(820))
    await vi.advanceTimersByTimeAsync(30_000 - 1)
    await expect(refreshOnce({ id: 'h3', data: { refresh: 'old-rt', sid } }, base)).resolves.toEqual(adopted(791))
    // The second taking does not extend the window.
    fetchSpy.mockResolvedValue(new Response('{}', { status: 401 }))
    await vi.advanceTimersByTimeAsync(1)
    await expect(refreshOnce({ id: 'h3', data: { refresh: 'old-rt', sid } }, base)).resolves.toEqual({ pair: null, retryable: false })
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('is let go after the straggler window, even once the session has rotated the token it handed out', async () => {
    // R1 → R2 was held and taken; the session then rotates R2 itself. An R1 presented once the burst is
    // over must reach lukk, whose reuse detection is the right answer to a token two rotations old.
    const sid = `moved-${Math.random()}`
    const fetchSpy = await lateRotation(sid)
    await expect(refreshOnce({ id: 'h3', data: { refresh: 'old-rt', sid } }, base)).resolves.toEqual(adopted())
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ access_token: 'a3', refresh_token: 'r3' }), { status: 200 }))
    await refreshOnce({ id: 'h3', data: { refresh: 'late-rt', sid } }, base)
    await vi.advanceTimersByTimeAsync(30_000)

    fetchSpy.mockResolvedValue(new Response('{}', { status: 401 }))
    await expect(refreshOnce({ id: 'h3', data: { refresh: 'old-rt', sid } }, base)).resolves.toEqual({ pair: null, retryable: false })
    expect(JSON.parse(String(fetchSpy.mock.calls[2]![1]!.body))).toEqual({ refresh_token: 'old-rt' })
  })

  it('counts its expiry down to zero, and leaves an expiry lukk did not name unnamed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const answer = (body: object) => vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise((resolve) => {
      setTimeout(() => resolve(new Response(JSON.stringify(body), { status: 200 })), 20_000)
    }))
    const late = async (sid: string, after: number) => {
      void refreshOnce({ id: 'h3', data: { refresh: 'old-rt', sid } }, base)
      await vi.advanceTimersByTimeAsync(20_000 + after)
      return refreshOnce({ id: 'h3', data: { refresh: 'old-rt', sid } }, base)
    }

    answer({ access_token: 'a', refresh_token: 'r', expires_in: 30 })
    expect((await late(`short-${Math.random()}`, 60_000)).expiresIn).toBe(0)
    answer({ access_token: 'a', refresh_token: 'r' })
    const unnamed = await late(`unnamed-${Math.random()}`, 60_000)
    expect(unnamed.pair).toEqual({ access: 'a', refresh: 'r' })
    expect(unnamed).not.toHaveProperty('expiresIn')
  })

  it('is let go when the session ends — a logout or a sign-in never has it re-sealed', async () => {
    const sid = `ended-${Math.random()}`
    const fetchSpy = await lateRotation(sid)
    await endSession(sid)
    fetchSpy.mockResolvedValue(new Response('{}', { status: 401 }))
    // Past the ended-session record's own ten minutes, when nothing else stops the old cookie.
    await vi.advanceTimersByTimeAsync(10 * 60_000 - 1)
    forgetEndedSessions()

    await expect(refreshOnce({ id: 'h3', data: { refresh: 'old-rt', sid } }, base)).resolves.toEqual({ pair: null, retryable: false })
  })

  it('is never kept for a session that ended while the rotation was out', async () => {
    // Flight at 0, logout at 16 s, lukk answers at 200 s, the old cookie comes back at 620 s — after the
    // ended-session record has expired. Kept, that cookie would have been signed back in.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise((resolve) => {
      setTimeout(() => resolve(new Response(JSON.stringify(rotated), { status: 200 })), 200_000)
    }))
    const sid = `logout-${Math.random()}`
    void refreshOnce({ id: 'h3', data: { refresh: 'old-rt', sid } }, base)
    await vi.advanceTimersByTimeAsync(16_000)
    await endSession(sid)
    await vi.advanceTimersByTimeAsync(620_000 - 16_000)
    fetchSpy.mockResolvedValue(new Response('{}', { status: 401 }))

    await expect(refreshOnce({ id: 'h3', data: { refresh: 'old-rt', sid } }, base)).resolves.toEqual({ pair: null, retryable: false })
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('is never even held for a session already ended when it lands — not for a moment', async () => {
    // Let go a tick later, it was adoptable in between by any request reaching `refreshOnce` first.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const set = vi.spyOn(refreshJournals, 'set')
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise((resolve) => {
      setTimeout(() => resolve(new Response(JSON.stringify(rotated), { status: 200 })), 20_000)
    }))
    const sid = `gone-${Math.random()}`
    void refreshOnce({ id: 'h3', data: { refresh: 'old-rt', sid } }, base)
    await vi.advanceTimersByTimeAsync(16_000)
    markSessionEnded(sid)
    await vi.advanceTimersByTimeAsync(4_000)

    expect(set).not.toHaveBeenCalledWith(sid, expect.anything())
  })

  it('outlives the taker\'s own next refresh while the straggler window is open', async () => {
    // A short access TTL: the hold is taken at 6 min with what is left of a 300 s token — none — so the
    // taker refreshes T1 at once. A T0 request from the same burst, a second later, must still adopt:
    // dropped, it reached lukk with a token rotated minutes ago, and the family was revoked.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise((resolve) => {
      setTimeout(() => resolve(new Response(JSON.stringify({ access_token: 'a1', refresh_token: 't1', expires_in: 300 }), { status: 200 })), 20_000)
    }))
    const sid = `ttl-${Math.random()}`
    void refreshOnce({ id: 'h3', data: { refresh: 't0', sid } }, base)
    await vi.advanceTimersByTimeAsync(6 * 60_000)
    await expect(refreshOnce({ id: 'h3', data: { refresh: 't0', sid } }, base)).resolves.toMatchObject({ pair: { refresh: 't1' }, expiresIn: 0 })

    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ access_token: 'a2', refresh_token: 't2', expires_in: 300 }), { status: 200 }))
    await expect(refreshOnce({ id: 'h3', data: { refresh: 't1', sid } }, base)).resolves.toMatchObject({ pair: { refresh: 't2' } })
    await vi.advanceTimersByTimeAsync(1_000)

    // Forwarded to the taker's rotation: T1 is spent, and re-sealing it put the browser one replay away
    // from a revoke once lukk's grace window — as long as this one — had passed. Counted down from when
    // T2 was minted, a second ago.
    await expect(refreshOnce({ id: 'h3', data: { refresh: 't0', sid } }, base)).resolves.toEqual({ pair: { access: 'a2', refresh: 't2' }, expiresIn: 299, retryable: false })
    expect(fetchSpy).toHaveBeenCalledTimes(2)

    // T1 again — the taker's rotation of it is journalled too: a request still carrying it adopts the head,
    // and lukk is not asked to rotate a spent token a second time.
    await expect(refreshOnce({ id: 'h3', data: { refresh: 't1', sid } }, base)).resolves.toMatchObject({ pair: { refresh: 't2' } })
    expect(fetchSpy).toHaveBeenCalledTimes(2)

    // Any token outside the chain still lets it go at once.
    fetchSpy.mockResolvedValue(new Response('{}', { status: 401 }))
    await refreshOnce({ id: 'h3', data: { refresh: 'tX', sid } }, base)
    await refreshOnce({ id: 'h3', data: { refresh: 't0', sid } }, base)
    expect(fetchSpy).toHaveBeenCalledTimes(4)
  })

  it('forwards even when the taker\'s own rotation lands after it gave up — never replaced by a fresh hold', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const late = (body: object) => () => new Promise<Response>((resolve) => {
      setTimeout(() => resolve(new Response(JSON.stringify(body), { status: 200 })), 20_000)
    })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(late({ access_token: 'a1', refresh_token: 't1', expires_in: 300 }))
    const sid = `slow-taker-${Math.random()}`
    void refreshOnce({ id: 'h3', data: { refresh: 't0', sid } }, base)
    await vi.advanceTimersByTimeAsync(20_000)
    await refreshOnce({ id: 'h3', data: { refresh: 't0', sid } }, base) // taken: the window runs to 50 s
    fetchSpy.mockImplementation(late({ access_token: 'a2', refresh_token: 't2', expires_in: 300 }))
    void refreshOnce({ id: 'h3', data: { refresh: 't1', sid } }, base) // gives up at 35 s, lands at 40 s
    await vi.advanceTimersByTimeAsync(21_000)

    await expect(refreshOnce({ id: 'h3', data: { refresh: 't0', sid } }, base)).resolves.toMatchObject({ pair: { refresh: 't2' } })
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('forwards along the chain, never past the original window', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise((resolve) => {
      setTimeout(() => resolve(new Response(JSON.stringify({ access_token: 'a1', refresh_token: 't1', expires_in: 300 }), { status: 200 })), 20_000)
    }))
    const sid = `chain-${Math.random()}`
    void refreshOnce({ id: 'h3', data: { refresh: 't0', sid } }, base)
    await vi.advanceTimersByTimeAsync(20_000)
    await refreshOnce({ id: 'h3', data: { refresh: 't0', sid } }, base) // taken: the window runs to 50 s
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ access_token: 'a2', refresh_token: 't2', expires_in: 300 }), { status: 200 }))
    await refreshOnce({ id: 'h3', data: { refresh: 't1', sid } }, base)
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ access_token: 'a3', refresh_token: 't3', expires_in: 300 }), { status: 200 }))
    await refreshOnce({ id: 'h3', data: { refresh: 't2', sid } }, base) // the newest handed-out token: forwarded again

    await expect(refreshOnce({ id: 'h3', data: { refresh: 't0', sid } }, base)).resolves.toMatchObject({ pair: { refresh: 't3' } })
    await vi.advanceTimersByTimeAsync(30_000) // the window from the FIRST taking is over
    fetchSpy.mockResolvedValue(new Response('{}', { status: 401 }))
    await expect(refreshOnce({ id: 'h3', data: { refresh: 't0', sid } }, base)).resolves.toEqual({ pair: null, retryable: false })
  })

  it('does not forward a hold the session\'s end let go, nor one the taker\'s rotation failed to replace', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise((resolve) => {
      setTimeout(() => resolve(new Response(JSON.stringify({ access_token: 'a1', refresh_token: 't1', expires_in: 300 }), { status: 200 })), 20_000)
    }))
    const refused = `refused-${Math.random()}`
    void refreshOnce({ id: 'h3', data: { refresh: 't0', sid: refused } }, base)
    await vi.advanceTimersByTimeAsync(20_000)
    await refreshOnce({ id: 'h3', data: { refresh: 't0', sid: refused } }, base)
    fetchSpy.mockResolvedValue(new Response('{}', { status: 429 }))
    await refreshOnce({ id: 'h3', data: { refresh: 't1', sid: refused } }, base)
    await expect(refreshOnce({ id: 'h3', data: { refresh: 't0', sid: refused } }, base)).resolves.toMatchObject({ pair: { refresh: 't1' } })

    // Logged out while the taker's rotation was out: nothing to forward to, nothing re-sealed.
    const ended = `ended-fwd-${Math.random()}`
    fetchSpy.mockImplementation(() => new Promise((resolve) => {
      setTimeout(() => resolve(new Response(JSON.stringify({ access_token: 'a1', refresh_token: 't1', expires_in: 300 }), { status: 200 })), 20_000)
    }))
    void refreshOnce({ id: 'h3', data: { refresh: 't0', sid: ended } }, base)
    await vi.advanceTimersByTimeAsync(20_000)
    await refreshOnce({ id: 'h3', data: { refresh: 't0', sid: ended } }, base)
    let land!: (r: Response) => void
    fetchSpy.mockImplementation(() => new Promise((resolve) => { land = resolve }))
    const rotating = refreshOnce({ id: 'h3', data: { refresh: 't1', sid: ended } }, base)
    await vi.advanceTimersByTimeAsync(0)
    await endSession(ended)
    land(new Response(JSON.stringify({ access_token: 'a2', refresh_token: 't2' }), { status: 200 }))
    await rotating
    expect(refreshJournals.has(ended)).toBe(false)
  })

  it('is let go by the taker\'s next refresh once the straggler window has closed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const sid = `closed-${Math.random()}`
    const fetchSpy = await lateRotation(sid)
    await refreshOnce({ id: 'h3', data: { refresh: 'old-rt', sid } }, base)
    await vi.advanceTimersByTimeAsync(30_000)
    fetchSpy.mockResolvedValue(new Response('{}', { status: 401 }))
    await refreshOnce({ id: 'h3', data: { refresh: 'old-rt', sid } }, base)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('is never kept for a session another instance ended (the shared store)', async () => {
    useSharedEndedSessions({ mark: async () => {}, has: async key => key === sid })
    const sid = `shared-${Math.random()}`
    const fetchSpy = await lateRotation(sid)
    fetchSpy.mockResolvedValue(new Response('{}', { status: 401 }))

    await expect(refreshOnce({ id: 'h3', data: { refresh: 'old-rt', sid } }, base)).resolves.toEqual({ pair: null, retryable: false })
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

  it('leaves a newer outcome alone when an older one for the same session expires', async () => {
    // Two rotations of one session out at once — different tokens, so neither joined the other — both land
    // with nobody waiting. The second replaces the first; the first one's expiry must not take it with it.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve(new Response(JSON.stringify(rotated), { status: 200 })), 20_000)))
      .mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve(new Response(JSON.stringify({ access_token: 'x-at', refresh_token: 'x-rt' }), { status: 200 })), 5 * 60_000)))
    const sid = `two-${Math.random()}`
    void refreshOnce({ id: 'h3', data: { refresh: 'old-rt', sid } }, base)
    void refreshOnce({ id: 'h3', data: { refresh: 'x-old', sid } }, base)
    await vi.advanceTimersByTimeAsync(5 * 60_000) // both landed: `x-old`'s outcome replaced `old-rt`'s
    await vi.advanceTimersByTimeAsync(6 * 60_000) // past the first one's ten minutes

    await expect(refreshOnce({ id: 'h3', data: { refresh: 'x-old', sid } }, base)).resolves.toMatchObject({ pair: { access: 'x-at' } })
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('keeps no timer once let go', async () => {
    const sid = `timers-${Math.random()}`
    await lateRotation(sid)
    expect(vi.getTimerCount()).toBe(1) // the hold's own
    await endSession(sid)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('once taken late in its ten minutes, still lasts the full straggler window', async () => {
    // The first taking gives the burst it belongs to its thirty seconds, even past the ten minutes: cut at
    // the ten minutes, the user who came back at 9:59 had the rest of their page's requests replay the
    // consumed token — and the family revoked. A hold therefore lasts at most ten minutes + thirty seconds.
    const sid = `late-take-${Math.random()}`
    const fetchSpy = await lateRotation(sid) // landed at 20 s: ten minutes to 620 s
    await vi.advanceTimersByTimeAsync(599_000) // 619 s
    await refreshOnce({ id: 'h3', data: { refresh: 'old-rt', sid } }, base)
    await vi.advanceTimersByTimeAsync(1_500) // 620.5 s: past the original ten minutes, inside the thirty seconds
    await expect(refreshOnce({ id: 'h3', data: { refresh: 'old-rt', sid } }, base)).resolves.toMatchObject({ pair: { access: 'late-at' } })
    expect(fetchSpy).toHaveBeenCalledOnce()

    // A second taking extends nothing: the window from the first ends at 649 s.
    fetchSpy.mockResolvedValue(new Response('{}', { status: 401 }))
    await vi.advanceTimersByTimeAsync(28_500) // 649 s
    await expect(refreshOnce({ id: 'h3', data: { refresh: 'old-rt', sid } }, base)).resolves.toEqual({ pair: null, retryable: false })
  })

  it('keeps a rotation a caller received only for the straggler window', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise((resolve) => {
      setTimeout(() => resolve(new Response(JSON.stringify(rotated), { status: 200 })), 10_000)
    }))
    const sid = `delivered-${Math.random()}`

    const first = refreshOnce({ id: 'h3', data: { refresh: 'old-rt', sid } }, base)
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(first).resolves.toEqual(adopted(900)) // the clock is real here: no time has passed for lukk's token
    await vi.advanceTimersByTimeAsync(30_000)
    void refreshOnce({ id: 'h3', data: { refresh: 'old-rt', sid } }, base)

    expect(fetchSpy).toHaveBeenCalledTimes(2) // thirty seconds after it was received, lukk's to rule on
  })

  it('counts a rotation received by one of two callers as received', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise((resolve) => {
      setTimeout(() => resolve(new Response(JSON.stringify(rotated), { status: 200 })), 20_000)
    }))
    const sid = `half-${Math.random()}`

    void refreshOnce({ id: 'h3', data: { refresh: 'old-rt', sid } }, base)
    await vi.advanceTimersByTimeAsync(10_000)
    const second = refreshOnce({ id: 'h3', data: { refresh: 'old-rt', sid } }, base) // waits until 25 s
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(second).resolves.toEqual(adopted(900)) // the clock is real here
    await vi.advanceTimersByTimeAsync(30_000) // not the ten minutes a rotation nobody received gets
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

describe('the session\'s rotation journal', () => {
  const base = 'https://api.example.com/auth'
  const pair = (n: number, expiresIn = 300) => ({ access_token: `a${n}`, refresh_token: `t${n}`, expires_in: expiresIn })
  /** lukk answering `/refresh` with `body` after `lagMs`. */
  const answers = (body: object | number, lagMs: number) => () => new Promise<Response>((resolve) => {
    setTimeout(() => resolve(typeof body === 'number' ? new Response('{}', { status: body }) : new Response(JSON.stringify(body), { status: 200 })), lagMs)
  })
  const present = (sid: string, token: string) => refreshOnce({ id: 'h3', data: { refresh: token, sid } }, base)
  let fetchSpy: ReturnType<typeof vi.spyOn<typeof globalThis, 'fetch'>>

  /** T0 → T1 lands at 20 s with nobody waiting (the caller gave up at 15 s). */
  async function unreceivedRotation(sid: string) {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(answers(pair(1), 20_000))
    void present(sid, 't0')
    await vi.advanceTimersByTimeAsync(20_000)
  }

  afterEach(() => { vi.useRealTimers(); forgetEndedSessions(); useSharedEndedSessions(undefined) })

  it('(1) adopts a rotation the taker\'s own refresh left unreceived — and lets the taken link expire', async () => {
    // Previously revoked: the hold followed only the taker's rotation it saw land with someone waiting.
    const sid = `j1-${Math.random()}`
    await unreceivedRotation(sid)
    await expect(present(sid, 't0')).resolves.toMatchObject({ pair: { refresh: 't1' } }) // taken at 20 s
    await vi.advanceTimersByTimeAsync(1_000)
    fetchSpy.mockImplementation(answers(pair(2), 20_000))
    const taker = present(sid, 't1') // leaves at 21 s, gives up at 36 s, lands at 41 s unreceived
    await vi.advanceTimersByTimeAsync(15_000)
    await expect(taker).resolves.toMatchObject({ pair: null, retryAfter: 5 })
    await vi.advanceTimersByTimeAsync(120_000 - 36_000)

    await expect(present(sid, 't1')).resolves.toEqual({ pair: { access: 'a2', refresh: 't2' }, expiresIn: 201, retryable: false })
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    // T0's own link was taken at 20 s and lived thirty seconds: at 120 s it is lukk's to rule on.
    fetchSpy.mockResolvedValue(new Response('{}', { status: 401 }))
    await expect(present(sid, 't0')).resolves.toEqual({ pair: null, retryable: false })
    expect(fetchSpy).toHaveBeenCalledTimes(3)
  })

  it('(2) makes a straggler wait for the head\'s rotation in flight, and hands it the result — never the token being rotated', async () => {
    const sid = `j2-${Math.random()}`
    await unreceivedRotation(sid)
    await present(sid, 't0') // taken at 20 s
    fetchSpy.mockImplementation(answers(pair(2), 2_000))
    const taker = present(sid, 't1') // 20–22 s
    await vi.advanceTimersByTimeAsync(1_000)
    const straggler = present(sid, 't0') // 21 s
    await vi.advanceTimersByTimeAsync(1_000)

    await expect(taker).resolves.toMatchObject({ pair: { refresh: 't2' } })
    await expect(straggler).resolves.toMatchObject({ pair: { access: 'a2', refresh: 't2' } })
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('(3) gives a straggler nothing once lukk refused the chain — waiting on that refusal, or after it', async () => {
    const sid = `j3-${Math.random()}`
    await unreceivedRotation(sid)
    await present(sid, 't0')
    fetchSpy.mockImplementation(answers(401, 2_000))
    const taker = present(sid, 't1')
    await vi.advanceTimersByTimeAsync(1_000)
    const waiting = present(sid, 't0')
    await vi.advanceTimersByTimeAsync(1_000)

    await expect(taker).resolves.toEqual({ pair: null, retryable: false })
    await expect(waiting).resolves.toEqual({ pair: null, retryable: false })
    // And one arriving after: the journal is gone, so the old token goes to lukk — which refuses it too.
    fetchSpy.mockResolvedValue(new Response('{}', { status: 401 }))
    await expect(present(sid, 't0')).resolves.toEqual({ pair: null, retryable: false })
    expect(fetchSpy).toHaveBeenCalledTimes(3)
  })

  it('(3b) keeps the chain through a refresh that failed but may be retried', async () => {
    const sid = `j3b-${Math.random()}`
    await unreceivedRotation(sid)
    await present(sid, 't0')
    fetchSpy.mockResolvedValue(new Response('{}', { status: 429 }))
    await present(sid, 't1')
    await expect(present(sid, 't0')).resolves.toMatchObject({ pair: { refresh: 't1' } })
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('(4) links a sibling lukk issued for the head\'s token, and a straggler arriving while it is out adopts it', async () => {
    // lukk answers a replay inside its grace window with a sibling (T1 → T3) — T1 rotated elsewhere, say,
    // another instance this one never heard of. That is the chain going on, not the session moving away
    // from it, and a T0 straggler arriving while it is out must get T3: the hold model handed it T1, the
    // token being rotated at that very moment.
    const sid = `j4-${Math.random()}`
    await unreceivedRotation(sid)
    await present(sid, 't0') // taken at 20 s: T0's link lasts to 50 s
    fetchSpy.mockImplementation(answers(pair(3), 2_000))
    const sibling = present(sid, 't1')
    await vi.advanceTimersByTimeAsync(1_000)
    const straggler = present(sid, 't0')
    await vi.advanceTimersByTimeAsync(1_000)

    await expect(sibling).resolves.toMatchObject({ pair: { refresh: 't3' } })
    await expect(straggler).resolves.toMatchObject({ pair: { access: 'a3', refresh: 't3' } })
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(present(sid, 't0')).resolves.toEqual({ pair: { access: 'a3', refresh: 't3' }, expiresIn: 288, retryable: false })
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('never lets a link outlive the link that delivered its pair — an old cookie is not handed a rotated token', async () => {
    // t0 T0 → T1, received. t1 T1 presented; lukk takes 16 s, so it lands at ~17 s unreceived (ten minutes).
    // t18 a T0 straggler is handed T2 through it. t21 T2 → T3, received (thirty seconds). Left on its ten
    // minutes, the T1 link outlived T2 → T3, and at 9 min an old T1 cookie was handed T2 — rotated long ago.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(pair(1)), { status: 200 }))
    const sid = `mono-${Math.random()}`
    await present(sid, 't0')
    await vi.advanceTimersByTimeAsync(1_000)
    fetchSpy.mockImplementation(answers(pair(2), 16_000))
    void present(sid, 't1')
    await vi.advanceTimersByTimeAsync(17_000) // gave up at 16 s; landed at 17 s with nobody waiting
    await expect(present(sid, 't0')).resolves.toMatchObject({ pair: { refresh: 't2' } }) // 18 s
    await vi.advanceTimersByTimeAsync(3_000)
    fetchSpy.mockImplementation(async () => new Response(JSON.stringify(pair(3)), { status: 200 }))
    await present(sid, 't2') // 21 s, received
    await vi.advanceTimersByTimeAsync(9 * 60_000 - 21_000)

    fetchSpy.mockImplementation(async () => new Response('{}', { status: 401 }))
    await expect(present(sid, 't1')).resolves.toEqual({ pair: null, retryable: false })
    expect(fetchSpy).toHaveBeenCalledTimes(4)
  })

  it('takes every link on the way to the head a straggler adopts, not only the one it presented', async () => {
    // As above, but the session never presents T2 afterwards: only the straggler's adoption through the T1
    // link says T2 has reached the session, and the T1 link must not keep handing it out for ten minutes.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(pair(1)), { status: 200 }))
    const sid = `hops-${Math.random()}`
    await present(sid, 't0')
    await vi.advanceTimersByTimeAsync(1_000)
    fetchSpy.mockImplementation(answers(pair(2), 16_000))
    void present(sid, 't1')
    await vi.advanceTimersByTimeAsync(17_000)
    await expect(present(sid, 't0')).resolves.toMatchObject({ pair: { refresh: 't2' } }) // 18 s
    await vi.advanceTimersByTimeAsync(30_000)

    fetchSpy.mockImplementation(async () => new Response('{}', { status: 401 }))
    await expect(present(sid, 't1')).resolves.toEqual({ pair: null, retryable: false })
  })

  it('also shortens a waiting link the moment the session presents the pair it produced', async () => {
    // T1 → T2 landed unreceived; the session then presents T2 itself — so T2 reached it, through some other
    // way. The T1 link has done its job, and lasts only the straggler window from there.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(answers(pair(2), 20_000))
    const sid = `mono2-${Math.random()}`
    void present(sid, 't1')
    await vi.advanceTimersByTimeAsync(20_000) // T1 → T2, nobody waiting: ten minutes
    fetchSpy.mockImplementation(async () => new Response(JSON.stringify(pair(3)), { status: 200 }))
    await present(sid, 't2') // the head's own token: chain goes on, T2 → T3 received
    await vi.advanceTimersByTimeAsync(30_000)

    fetchSpy.mockImplementation(async () => new Response('{}', { status: 401 }))
    await expect(present(sid, 't1')).resolves.toEqual({ pair: null, retryable: false })
  })

  it('counts expires_in from when lukk minted the token — the refresh leaving — never overstating it', async () => {
    // lukk mints on receipt and answers 14 s later with `expires_in: 900`: 886 s are left, not 900. Told
    // 900, a client scheduled its renewal 14 s too late and met a 401.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(answers({ access_token: 'a', refresh_token: 'r', expires_in: 900 }, 14_500))
    const sid = `minted-${Math.random()}`
    const direct = present(sid, 't0')
    await vi.advanceTimersByTimeAsync(14_500)
    await expect(direct).resolves.toMatchObject({ expiresIn: 886 })
    // And never below zero, for a flight slower than the token's whole life.
    fetchSpy.mockImplementation(answers({ access_token: 'b', refresh_token: 'r2', expires_in: 10 }, 12_000))
    const slow = present(`slower-${Math.random()}`, 't0')
    await vi.advanceTimersByTimeAsync(12_000)
    await expect(slow).resolves.toMatchObject({ expiresIn: 0 })
    // No `expires_in` from lukk, none reported.
    fetchSpy.mockImplementation(answers({ access_token: 'c', refresh_token: 'r3' }, 3_000))
    const unnamed = present(`unnamed-${Math.random()}`, 't0')
    await vi.advanceTimersByTimeAsync(3_000)
    expect(await unnamed).not.toHaveProperty('expiresIn')
  })

  it.each([
    ['answers at 31 s, a straggler at landing + 0.1 s', 31_000, 20_000, 100],
    ['answers at 20 s, a straggler at landing + 11 s', 20_000, 10_000, 11_000],
  ])('counts a received link\'s window from when the BFF got the pair — lukk %s', async (_, lag, joinAt, after) => {
    // Counted from when the refresh left, the link was already gone (or nearly) when the pair landed: the
    // straggler found nothing, replayed t0 to lukk past its grace window, and the family was revoked. The
    // journal can therefore answer up to the refresh's duration + 30 s past lukk's rotation — deliberately.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(answers(pair(1), lag))
    const sid = `landing-${Math.random()}`
    void present(sid, 't0')
    await vi.advanceTimersByTimeAsync(joinAt)
    const r1 = present(sid, 't0') // joins, and is still waiting when lukk answers: received
    await vi.advanceTimersByTimeAsync(lag - joinAt)
    await expect(r1).resolves.toMatchObject({ pair: { refresh: 't1' } })
    await vi.advanceTimersByTimeAsync(after)

    await expect(present(sid, 't0')).resolves.toMatchObject({ pair: { refresh: 't1' } })
    expect(fetchSpy).toHaveBeenCalledOnce()
  })

  it('never lets an older link outlive the newer one it hands out', async () => {
    // t1 → t2 lands unreceived at 20 s; t2 is presented at 60 s and its rotation, received, lands at 80 s.
    // The t1 link then lasts no longer than the t2 link: an old t1 cookie at 95 s is handed t3 — never t2,
    // rotated at 60 s, whose next refresh would revoke the family.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(answers(pair(2), 20_000))
    const sid = `outlive-${Math.random()}`
    void present(sid, 't1')
    await vi.advanceTimersByTimeAsync(60_000)
    fetchSpy.mockImplementation(answers(pair(3), 20_000))
    void present(sid, 't2')
    await vi.advanceTimersByTimeAsync(10_000)
    const joined = present(sid, 't2') // waiting when it lands at 80 s
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(joined).resolves.toMatchObject({ pair: { refresh: 't3' } })
    await vi.advanceTimersByTimeAsync(15_000) // 95 s

    await expect(present(sid, 't1')).resolves.toMatchObject({ pair: { refresh: 't3' } })
    await vi.advanceTimersByTimeAsync(15_000) // 110 s: both gone together
    fetchSpy.mockImplementation(async () => new Response('{}', { status: 401 }))
    await expect(present(sid, 't1')).resolves.toEqual({ pair: null, retryable: false })
  })

  it('caps a link taken for the first time at the end of the link after it', async () => {
    // t1 reached here from elsewhere, and its rotation (t1 → t2) was received at 1 s: that link ends at 31 s.
    // Our own slow t0 → t1 lands unreceived at 20 s, after it. A t0 straggler adopting at 25 s takes the t0
    // link for the first time — but not past 31 s: outliving t1 → t2, it would hand t1, rotated, to an old
    // cookie at 33 s.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(answers(pair(1), 20_000))
    const sid = `cap-${Math.random()}`
    void present(sid, 't0')
    await vi.advanceTimersByTimeAsync(1_000)
    fetchSpy.mockImplementation(async () => new Response(JSON.stringify(pair(2)), { status: 200 }))
    await present(sid, 't1')
    await vi.advanceTimersByTimeAsync(24_000) // 25 s
    await expect(present(sid, 't0')).resolves.toMatchObject({ pair: { refresh: 't2' } })
    await vi.advanceTimersByTimeAsync(8_000) // 33 s

    fetchSpy.mockImplementation(async () => new Response('{}', { status: 401 }))
    await expect(present(sid, 't0')).resolves.toEqual({ pair: null, retryable: false })
  })

  it('cuts short only the link that handed out the token rotated — never an unrelated branch\'s', async () => {
    // Journal empty; c is out 40 s. x flies at 1 s; x → y lands unreceived at 21 s. c lands at 40 s. The x
    // link is untouched by c's landing, and x at 100 s still adopts y — cut short, x would be replayed.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(answers({ access_token: 'ac', refresh_token: 'd', expires_in: 300 }, 40_000))
    const sid = `branch-${Math.random()}`
    void present(sid, 'c')
    await vi.advanceTimersByTimeAsync(1_000)
    fetchSpy.mockImplementation(answers({ access_token: 'ay', refresh_token: 'y', expires_in: 300 }, 20_000))
    void present(sid, 'x')
    await vi.advanceTimersByTimeAsync(99_000)

    await expect(present(sid, 'x')).resolves.toMatchObject({ pair: { refresh: 'y' } })
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('hands an old cookie a live pair only within its link\'s window — ten minutes untaken, thirty seconds once taken', async () => {
    const sid = `jw-${Math.random()}`
    await unreceivedRotation(sid) // landed at 20 s
    await vi.advanceTimersByTimeAsync(9 * 60_000) // 9:20, well inside its ten minutes
    await expect(present(sid, 't0')).resolves.toMatchObject({ pair: { refresh: 't1' } })
    await vi.advanceTimersByTimeAsync(30_000 - 1)
    await expect(present(sid, 't0')).resolves.toMatchObject({ pair: { refresh: 't1' } }) // a second taking extends nothing
    fetchSpy.mockResolvedValue(new Response('{}', { status: 401 }))
    await vi.advanceTimersByTimeAsync(1)
    expect(refreshJournals.has(sid)).toBe(false) // its last link gone, the journal goes too
    await expect(present(sid, 't0')).resolves.toEqual({ pair: null, retryable: false })
  })

  it('survives an upstream that hands back the token it consumed — the chain loops, the process does not', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ access_token: 'a', refresh_token: 't0' }), { status: 200 }))
    const sid = `jl-${Math.random()}`
    await present(sid, 't0')

    await expect(present(sid, 't0')).resolves.toMatchObject({ pair: { refresh: 't0' } })
    expect(fetchSpy).toHaveBeenCalledOnce()
  })

  it('keeps a received rotation thirty seconds for the requests already out with the old cookie', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(answers(pair(1), 1_000))
    const sid = `jr-${Math.random()}`
    const received = present(sid, 't0')
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(received).resolves.toMatchObject({ pair: { refresh: 't1' } })

    // Thirty seconds from when the pair landed, at 1 s; its `expires_in` counted from when it was minted, at 0.
    await vi.advanceTimersByTimeAsync(30_000 - 1)
    await expect(present(sid, 't0')).resolves.toMatchObject({ pair: { refresh: 't1' }, expiresIn: 270 })
    fetchSpy.mockResolvedValue(new Response('{}', { status: 401 }))
    await vi.advanceTimersByTimeAsync(1)
    await expect(present(sid, 't0')).resolves.toEqual({ pair: null, retryable: false })
  })

  it('is dropped when the session presents a token outside it — and nothing is handed out after', async () => {
    const sid = `jx-${Math.random()}`
    await unreceivedRotation(sid)
    // A token lukk accepts, even: the journal goes because the session moved away from it, not because of
    // any refusal.
    fetchSpy.mockResolvedValue(new Response(JSON.stringify(pair(9)), { status: 200 }))
    await present(sid, 'tX')
    fetchSpy.mockResolvedValue(new Response('{}', { status: 401 }))
    await expect(present(sid, 't0')).resolves.toEqual({ pair: null, retryable: false })
    expect(fetchSpy).toHaveBeenCalledTimes(3)
  })

  it('is never consulted for another session, and dropped when the session ends', async () => {
    const sid = `je-${Math.random()}`
    await unreceivedRotation(sid)
    fetchSpy.mockResolvedValue(new Response('{}', { status: 401 }))
    await expect(present(`other-${Math.random()}`, 't0')).resolves.toEqual({ pair: null, retryable: false })
    markSessionEnded(sid)
    forgetEndedSessions()
    await expect(present(sid, 't0')).resolves.toEqual({ pair: null, retryable: false })
    expect(fetchSpy).toHaveBeenCalledTimes(3)
  })

  it('replaces a link when a second rotation of the same token lands — a hung one the backstop let go', async () => {
    // The first never answered within five minutes, so a second went out; then both answered. The newer
    // link stands, on its own lifetime — the first one's expiry must not take it.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const lands: ((r: Response) => void)[] = []
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise((resolve) => { lands.push(resolve) }))
    const sid = `jd-${Math.random()}`
    void present(sid, 't0')
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    void present(sid, 't0')
    await vi.advanceTimersByTimeAsync(15_000)
    lands[0]!(new Response(JSON.stringify(pair(1)), { status: 200 }))
    await vi.advanceTimersByTimeAsync(60_000)
    lands[1]!(new Response(JSON.stringify(pair(2)), { status: 200 }))
    await vi.advanceTimersByTimeAsync(9 * 60_000 + 1_000) // past the first link's ten minutes

    await expect(present(sid, 't0')).resolves.toMatchObject({ pair: { refresh: 't2' } })
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('keeps at most sixteen links per session, the oldest going first', async () => {
    const sid = `jc-${Math.random()}`
    await unreceivedRotation(sid) // t0 → t1
    for (let n = 1; n <= 16; n++) {
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify(pair(n + 1)), { status: 200 }))
      await present(sid, `t${n}`) // t1 → t2 … t16 → t17: seventeen links in all
    }
    expect(refreshJournals.get(sid)!.size).toBe(16)
    expect(vi.getTimerCount()).toBe(16) // the pruned link's timer went with it
    fetchSpy.mockResolvedValue(new Response('{}', { status: 401 }))
    await expect(present(sid, 't0')).resolves.toEqual({ pair: null, retryable: false }) // pruned: lukk's to rule on
  })
})

describe('currentPair', () => {
  it('follows a pair on to the newest the session\'s journal holds, and leaves anything else as it is', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'a1', refresh_token: 't1' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'a2', refresh_token: 't2' }), { status: 200 }))
    const sid = `current-${Math.random()}`
    await refreshOnce({ id: 'h3', data: { refresh: 't0', sid } }, 'https://lukk/auth')
    const handed = { access: 'a1', refresh: 't1' }
    expect(currentPair(sid, handed)).toBe(handed) // nothing newer yet
    await refreshOnce({ id: 'h3', data: { refresh: 't1', sid } }, 'https://lukk/auth')

    expect(currentPair(sid, handed)).toEqual({ access: 'a2', refresh: 't2' })
    expect(currentPair(`other-${Math.random()}`, handed)).toBe(handed)
    expect(currentPair(undefined, handed)).toBe(handed)
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

  it('joins a refresh in flight only with the token it is rotating — another token is lukk\'s to rule on', async () => {
    let answer!: (r: Response) => void
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => new Promise((resolve) => { answer = resolve }))
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
    const sid = `s-${Math.random()}`

    const rotating = refreshOnce({ id: 'h3', data: { refresh: 'rA', sid } }, 'https://lukk/auth')
    const other = await refreshOnce({ id: 'h3', data: { refresh: 'rX', sid } }, 'https://lukk/auth')
    const joined = refreshOnce({ id: 'h3', data: { refresh: 'rA', sid } }, 'https://lukk/auth')
    answer(new Response(JSON.stringify({ access_token: 'A2' }), { status: 200 }))

    expect(other).toEqual({ pair: null, retryable: false })
    expect((await joined).pair?.access).toBe('A2')
    expect((await rotating).pair?.access).toBe('A2')
    expect(fetchSpy).toHaveBeenCalledTimes(2)
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

  it('counts expires_in down for a session with no identity too', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      const slow = (body: object) => vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise((resolve) => {
        setTimeout(() => resolve(answer(200, body)), 13_000)
      }))
      const anonymous = async () => {
        const result = refreshOnce({ data: { refresh: 'rt' } }, 'https://lukk/auth')
        await vi.advanceTimersByTimeAsync(13_000)
        return result
      }
      slow({ access_token: 'a', expires_in: 100 })
      expect((await anonymous()).expiresIn).toBe(87) // 13 s gone of 100
      slow({ access_token: 'a', expires_in: 10 })
      expect((await anonymous()).expiresIn).toBe(0)
      slow({ access_token: 'a' })
      expect(await anonymous()).not.toHaveProperty('expiresIn')
    }
    finally { vi.useRealTimers() }
  })

  it('never collapses two sessions that have no identity', async () => {
    // Without a key, joining an in-flight refresh would hand one visitor another visitor's tokens.
    let first!: (r: Response) => void
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => new Promise((resolve) => { first = resolve }))
      .mockResolvedValueOnce(answer(200, { access_token: 'B2' }))

    // The same token, even: with no identity there is nothing to say they are one session.
    const a = refreshOnce({ data: { refresh: 'rA' } }, 'https://lukk/auth')
    const b = await refreshOnce({ data: { refresh: 'rA' } }, 'https://lukk/auth')

    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(b.pair?.access).toBe('B2')
    first(answer(200, { access_token: 'A2' }))
    expect((await a).pair?.access).toBe('A2')
  })
})

import { isSessionEnded, sessionEnded, sessionKey } from './ended-sessions'
import { forgetRefreshJournal, type Link, refreshJournals } from './refresh-journal'
import { reportUnusableBase, resolveTarget, UPSTREAM_TIMEOUT_MS } from './proxy-utils'

export interface TokenSession {
  access?: string
  refresh?: string
  confirmation?: string
  /** Identifies this sealed session across refreshes; minted by each sign-in. See `ended-sessions.ts`. */
  sid?: string
}

// Per-session single-flight, shared by BOTH proxies (the lukk-auth `bff.ts` and the
// app-API proxy) so a concurrent auth-401 refresh and an app-API proactive refresh
// for the same session collapse to ONE `/refresh` — the rotating token is never
// replayed (which reuse detection would punish with a family revoke).
//
// On `globalThis`, not module scope: the Nuxt app's server bundle (SSR hydration) gets its own copy of
// this module, separate from Nitro's handlers, so a module-level Map never collapsed a page render's
// refresh with a proxy's for the same session.
const inflightRefresh: Map<string, Flight> = ((globalThis as { __lukkInflightRefresh?: Map<string, Flight> }).__lukkInflightRefresh ??= new Map())
// What each rotation produced is journalled in `refresh-journal.ts`.

/** A refresh on the wire, and how many callers are still waiting on it. */
interface Flight {
  run: Promise<RefreshResult>
  waiting: number
  /** When it left — about when lukk rotated, since lukk rotates on receipt. */
  startedAt: number
}

/**
 * The outcome of a rotation attempt.
 *
 * `retryable` is the load-bearing part: only a definitive rejection by lukk (401/403 — the token is
 * revoked, reused, or expired) means the session is over. A 429, a 5xx, or an unusable `baseURL`
 * leaves the refresh token UNCONSUMED and still valid, so a caller must not discard the session over
 * one. Collapsing every failure into "no pair" turned a transient throttle into a permanent logout.
 */
export type RefreshResult = {
  pair: TokenSession | null
  expiresIn?: number
  retryable: boolean
  /** Seconds after which to try again — set only when this caller stopped WAITING on a refresh still out. */
  retryAfter?: number
}

/**
 * How long one caller waits on a refresh — the rotation itself is never cut short (see `rawRefresh`).
 *
 * The upstream deadline: a request is not held longer on a refresh than on any other call to lukk. A
 * caller that gives up answers "couldn't tell, retry in `REFRESH_RETRY_AFTER_S`". Its retry joins the
 * refresh if it is still out, and adopts the outcome from the session's rotation journal if it landed meanwhile — neither
 * replays the consumed token, so nothing here leans on lukk's grace window being long enough.
 */
export const REFRESH_WAIT_MS = UPSTREAM_TIMEOUT_MS

/** The `Retry-After` a caller that stopped waiting is told. */
export const REFRESH_RETRY_AFTER_S = 5

/**
 * How long a refresh stays joinable if it never settles. undici gives up on its own within minutes, but a
 * runtime without a transport timeout would keep a hung connection — and with it the session's
 * single-flight entry, which every later refresh for the session would join — forever. Past this, the
 * next refresh starts afresh. Long, because dropping it early is exactly the replay the entry prevents.
 */
export const REFRESH_INFLIGHT_MAX_MS = 5 * 60_000

/**
 * THE ROTATION JOURNAL. Every rotation that lands with a pair is recorded per session as a link from the
 * refresh token it consumed to the pair it produced; following links from any recorded token reaches the
 * chain's HEAD, the newest pair. A request still presenting a token that has a live link is handed that
 * head — sealed by whichever caller it reached (the auth proxy's `/refresh` or 401 retry, the app-API
 * proxy, SSR hydration) — rather than replaying a spent token to lukk.
 *
 * Why it exists: a refresh is never aborted, but its callers stop waiting after `REFRESH_WAIT_MS`. A
 * rotation that then landed with nobody left to receive it was lost — the session kept the consumed token,
 * its next refresh came at the user's next action, long past lukk's grace window, and reuse detection
 * revoked the family as stolen. The same happened to a page's burst of requests still carrying the old
 * cookie after one of them had rotated it, and to a straggler handed a pair whose token the session was
 * rotating at that very moment (it now waits on that rotation and is handed what it produced).
 *
 * Each link lives on its own: `REFRESH_HOLD_MS` for its first taker when no caller received it, and
 * `REFRESH_STRAGGLER_MS` once its pair has reached the session — from when the BFF got the pair if a caller
 * received it; from when a request first adopts through it otherwise (outright, so a hold lasts at most
 * `REFRESH_HOLD_MS` + `REFRESH_STRAGGLER_MS`: the burst of a user returning near its end still has its
 * thirty seconds); and cut to that window when the rotation of the pair it handed out lands. After that its
 * end is only ever brought forward, and never past the end of the link after it in its chain. And a caller
 * about to seal a pair it was handed asks the journal again at the last moment (`currentPair`): the session
 * may have rotated it meanwhile. So answers from the journal can come up to a refresh's duration + 30 s
 * after lukk rotated — past lukk's own grace window, on a slow refresh. That is deliberate: counted from
 * lukk's rotation instead, a slow refresh's link was gone as it landed, and the requests still out with the
 * old cookie replayed it into a revoke. The whole journal goes when the session presents a token outside it (it has moved
 * on), when lukk refuses one of its tokens outright, and when the session ends; a retryable failure keeps
 * it. Never recorded for a session that has ended. At most `REFRESH_JOURNAL_MAX_LINKS` per session.
 *
 * Tokens are kept as they are, not as digests: comparing synchronously leaves no `await` between "nothing
 * recorded, no refresh out" and starting one, in which a concurrent request could replay a spent token.
 * They are spent anyway, and anyone who could present one already holds the sealed cookie it came from.
 *
 * **A deliberate deviation.** A replay answered from the journal never reaches lukk, so lukk's reuse
 * detection — and its `RefreshFamilyForked` event — never sees it. RFC 9700 §4.14.2 treats such a replay as
 * the signal of a stolen token; here, inside the windows above, it is read as this browser catching up.
 * Outside them, it reaches lukk as before.
 *
 * **Per process.** A multi-instance BFF without sticky sessions does not share it; there, a retry reaching
 * another instance replays the consumed token, and only lukk's grace window stands between it and a revoke.
 *
 * An accepted limit: a link's window can close before the browser has the pair — the response that carried
 * it was lost (a navigation aborts it). Its replay then revokes the family, the same exposure an ordinary
 * rotation has when its response is lost. A longer window would widen the time in which an old cookie
 * somewhere else is answered with a live pair.
 */
export const REFRESH_HOLD_MS = 10 * 60_000

/**
 * How long a link stays adoptable once a caller has received or taken it: for the requests already out
 * with the old cookie (a page coming back fires several at once). At least a caller's wait plus its
 * `Retry-After`, and comparable to lukk's own grace window. Past it, a request presenting the consumed token
 * is not this browser catching up — it is an old cookie somewhere else, and lukk's reuse detection is the
 * right answer to it.
 */
export const REFRESH_STRAGGLER_MS = 30_000

/** The most links a session's journal keeps; the oldest goes first. */
export const REFRESH_JOURNAL_MAX_LINKS = 16

/** Single-flight the server-side refresh per session, returning the rotation outcome. */
export function refreshOnce(session: { id?: string, data: TokenSession }, baseURL: string, clientIp = ''): Promise<RefreshResult> {
  const token = session.data.refresh!
  // Keyed by the session's own `sid`, not h3's id: a sign-in re-seals the NEW session under the old h3
  // id, so a refresh for it would otherwise join one still out for the session it replaced, and seal
  // that session's tokens under the new one.
  const id = sessionKey(session)
  // No id → don't key the map (an empty key would collapse distinct sessions).
  if (!id) {
    const startedAt = Date.now()
    return waitOn({ run: rawRefresh(token, baseURL, clientIp).then(result => countedDown(result, startedAt)), waiting: 0, startedAt })
  }

  const journal = refreshJournals.get(id)
  if (journal?.has(token)) return adopt(id, journal, token)
  // The head's own token is the chain going on (and lukk's to rule on); any other token means the session
  // has moved on, and its journal with it.
  if (journal && ![...journal.values()].some(recorded => recorded.pair.refresh === token)) forgetRefreshJournal(id)

  // Joined only by a request presenting the token it is rotating — the flight is keyed by both. One with
  // another token is lukk's to rule on: joined, it was handed a pair its own token never earned.
  return waitOn(inflightRefresh.get(flightKey(id, token)) ?? fly(id, token, baseURL, clientIp))
}

/**
 * The head of the chain `token`'s link starts, for a request presenting it. Every link on the way has now
 * delivered its pair to the session, so it lasts at most the straggler window from here — and no link lasts
 * longer than the one after it: an older link outliving the newer ones handed an old cookie a pair rotated
 * since.
 *
 * While the head's own token is being rotated, the request waits for that rotation and is handed what it
 * produced — the new head, journalled as it lands; handing out the head as it stood gave the straggler a
 * token the session was spending at that moment. A refusal ends the chain, and the refusal is what it gets;
 * a caller that stops waiting, or a throttle, is told so, and retrying finds the chain where it was.
 */
function adopt(id: string, journal: Map<string, Link>, token: string): Promise<RefreshResult> {
  const path = chainFrom(journal, token)
  // From the head back: each gets the straggler window from now — outright on its first taking, so the
  // burst it belongs to has its thirty seconds even near the end of a ten-minute hold — but never past the
  // end of the one after it.
  let until = Date.now() + REFRESH_STRAGGLER_MS
  for (const [hop, link] of [...path].reverse()) {
    take(id, hop, link, until)
    until = link.expiresAt
  }
  const head = path.at(-1)![1]
  const rotating = inflightRefresh.get(flightKey(id, head.pair.refresh!))
  return rotating ? waitOn(rotating) : Promise.resolve(handOut(head))
}

/** `token`'s link and every link after it, in order: consumed token → link, ending at the head. */
function chainFrom(journal: Map<string, Link>, token: string): [string, Link][] {
  const path: [string, Link][] = [[token, journal.get(token)!]]
  // Bounded by the journal's size, which only matters for an upstream that handed back a token it had
  // already consumed: the chain would loop, and the process with it.
  // Stryker disable next-line EqualityOperator: equivalent — one more hop around a loop lands on a link of the same loop, and lukk never issues a token it consumed, so outside a loop the `break` ends it first.
  for (let hops = 0; hops < journal.size; hops++) {
    const hop = path.at(-1)![1].pair.refresh!
    const next = journal.get(hop)
    if (!next) break
    path.push([hop, next])
  }
  return path
}

/**
 * The newest pair the session's journal leads to from `pair` — `pair` itself when nothing newer is known.
 *
 * For a caller about to seal a pair it was handed a moment ago: the session may have rotated it since (a
 * restore in another tab, a sibling request), and a cookie sealed with it would then land over the newer
 * one with a token already spent, whose next refresh — once its link has expired — revokes the family. So
 * each caller asks again at the last moment before its cookie leaves: the auth proxy's retry when it seals,
 * the app-API proxy when the upstream's headers arrive, SSR hydration once the page has rendered.
 */
export function currentPair(id: string | undefined, pair: TokenSession): TokenSession {
  const journal = refreshJournals.get(id!)
  if (!journal?.has(pair.refresh!)) return pair
  return chainFrom(journal, pair.refresh!).at(-1)![1].pair
}

/** A link's pair, with what is LEFT of its access token's lifetime. */
function handOut(link: Link): RefreshResult {
  return countedDown({ pair: link.pair, expiresIn: link.expiresIn, retryable: false }, link.mintedAt)
}

/**
 * `result` with its `expires_in` counted down from `since` — when the refresh left, which is when lukk minted
 * the token (lukk rotates on receipt). lukk's figure is a lifetime from THEN: reported as is after a slow
 * refresh, or from a journal minutes later, it overstated the token's life, and a client renewing on it met
 * a 401 first. Whole seconds elapsed, so it can only understate, by under one; never below zero.
 */
function countedDown(result: RefreshResult, since: number): RefreshResult {
  const { expiresIn, ...rest } = result
  if (expiresIn === undefined) return rest
  return { ...rest, expiresIn: Math.max(0, expiresIn - Math.floor((Date.now() - since) / 1000)) }
}

/**
 * Record that rotating `consumed` produced `result` — received by a caller, or for a first taker to come.
 *
 * Its window counts from NOW, when the BFF got the pair, not from when the refresh left. Counted from the
 * departure, a slow refresh's link was gone, or nearly, the moment it landed: the requests still out with
 * the old cookie found nothing, replayed it past lukk's grace window, and the family was revoked. The cost,
 * taken deliberately: an answer from the journal can come up to the refresh's duration + 30 s after lukk
 * rotated — beyond lukk's own grace window, on a slow refresh.
 */
function record(id: string, consumed: string, result: RefreshResult, flight: Flight): void {
  const journal = refreshJournals.get(id) ?? new Map<string, Link>()
  refreshJournals.set(id, journal)
  const now = Date.now()
  // The session just presented `consumed`, so the link that handed it out has done its job: it lasts the
  // straggler window from now — never longer than the link recorded below, which lasts at least that. Only
  // THAT link: another branch's untaken link has handed out nothing yet.
  for (const [token, link] of journal) {
    // Not marked taken: a request adopting through it later caps it at the link recorded below anyway.
    if (link.pair.refresh === consumed) shorten(id, token, link, now + REFRESH_STRAGGLER_MS)
  }
  // A second rotation of the same token (one the in-flight backstop gave up on, then both answered): the
  // newer one stands, on its own lifetime.
  clearTimeout(journal.get(consumed)?.timer)
  const received = flight.waiting > 0
  const link = { pair: result.pair!, expiresIn: result.expiresIn, mintedAt: flight.startedAt, taken: received } as Link
  expire(id, consumed, link, now + (received ? REFRESH_STRAGGLER_MS : REFRESH_HOLD_MS))
  journal.set(consumed, link)
  if (journal.size > REFRESH_JOURNAL_MAX_LINKS) {
    const [oldest, dropped] = journal.entries().next().value!
    clearTimeout(dropped.timer)
    journal.delete(oldest)
  }
  // And not for a session another instance ended: the shared store answers asynchronously.
  void sessionEnded(id).then((ended) => {
    if (ended) forgetRefreshJournal(id)
  })
}

/** A request adopted through `link`: on its first taking it ends at `until` outright, after that no later. */
function take(id: string, token: string, link: Link, until: number): void {
  if (link.taken) return shorten(id, token, link, until)
  link.taken = true
  expire(id, token, link, until)
}

/** End `link` at `until` if that is sooner than it would — once taken, a link's life is only brought forward. */
function shorten(id: string, token: string, link: Link, until: number): void {
  expire(id, token, link, Math.min(until, link.expiresAt))
}

/** End `link` at `at`: that link only, and the journal with its last. */
function expire(id: string, token: string, link: Link, at: number): void {
  clearTimeout(link.timer)
  link.expiresAt = at
  link.timer = unref(setTimeout(() => {
    // Every way a journal goes clears its timers first, so this one's is still there.
    const journal = refreshJournals.get(id)!
    journal.delete(token)
    if (journal.size === 0) refreshJournals.delete(id)
  }, at - Date.now()))
}

/** A session's refresh of one particular token. */
function flightKey(id: string, token: string): string {
  return `${id}\n${token}`
}

/** Start the session's refresh, and journal what it produced. */
function fly(id: string, token: string, baseURL: string, clientIp: string): Flight {
  const startedAt = Date.now()
  // lukk's answer as sent, for the journal; its callers get it counted down from when it was minted.
  const settled = rawRefresh(token, baseURL, clientIp)
  const flight: Flight = { run: settled.then(result => countedDown(result, startedAt)), waiting: 0, startedAt }
  const key = flightKey(id, token)
  inflightRefresh.set(key, flight)
  // Only ever THIS entry: once the backstop has dropped it, a newer refresh may hold the key.
  const forget = () => {
    clearTimeout(backstop)
    if (inflightRefresh.get(key) === flight) inflightRefresh.delete(key)
  }
  const backstop = unref(setTimeout(forget, REFRESH_INFLIGHT_MAX_MS))
  // Before `forget`, synchronously: there is no moment when the session has neither a flight nor the
  // journal entry, in which a request with the old token could start a replay. Never for a session that
  // ended while it was out. A refusal ends the chain; a retryable failure leaves it be.
  // Registered after the countdown above, so it runs before any caller is handed the result — and sees how
  // many are still waiting.
  settled.then((result) => {
    if (result.pair) {
      if (!isSessionEnded(id)) record(id, token, result, flight)
    }
    else if (!result.retryable) {
      forgetRefreshJournal(id)
    }
    forget()
  }, forget)
  return flight
}

/** The flight's outcome, or "retry shortly" once `REFRESH_WAIT_MS` has passed — the flight carries on regardless. */
function waitOn(flight: Flight): Promise<RefreshResult> {
  flight.waiting++
  let timer: ReturnType<typeof setTimeout> | undefined
  const gaveUp = new Promise<RefreshResult>((resolve) => {
    timer = unref(setTimeout(() => {
      flight.waiting--
      resolve({ pair: null, retryable: true, retryAfter: REFRESH_RETRY_AFTER_S })
    }, REFRESH_WAIT_MS))
  })
  return Promise.race([flight.run, gaveUp]).finally(() => clearTimeout(timer))
}

/**
 * A timer that never keeps the process alive: a hung lukk must not hold up a shutdown for minutes. On
 * workerd and Deno a timer is a plain number, with nothing to unref.
 */
function unref<T>(timer: T): T {
  (timer as { unref?: () => void }).unref?.()
  return timer
}

async function rawRefresh(refreshToken: string, baseURL: string, clientIp: string): Promise<RefreshResult> {
  // `/refresh` is a fixed literal that cannot escape, so a null here means only one thing: an
  // unusable `baseURL` (the module rejects one at build; reachable via a post-build runtime
  // override). Treat it as "not refreshable" rather than fetching `null` and throwing something
  // unreadable — and report it through the shared reporter, which masks credentials and logs once
  // per value, since this path runs per SSR render and per app-API request with an aged token.
  const target = resolveTarget(baseURL, '/refresh')
  if (!target) {
    reportUnusableBase('lukk `baseURL`', baseURL)
    // A deployment fault, not a dead session — the token was never even sent.
    return { pair: null, retryable: true }
  }
  // lukk rate-limits `/refresh` on `$request->ip()` too (30/60s by default), and this is the
  // highest-volume auth call in BFF mode — every proxied 401 and every SSR hydration lands here.
  // Without the visitor's address all of them share one bucket, so a busy deployment throttles
  // itself; with it, login and the refresh that follows also key on the same identity.
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Accept': 'application/json' }
  if (clientIp) headers['X-Forwarded-For'] = clientIp
  // Plain `fetch`, deliberately WITHOUT `fetchUpstream`'s deadline — the one upstream call here that
  // must never be cut short. lukk rotates the token as soon as it has the request, and an abort only
  // stops US listening: the rotation is committed, its replacement exists only in the response we just
  // walked away from, and the session still holds the consumed token. Its next refresh replays that token,
  // and once the grace window has passed reuse detection revokes the whole family as stolen (RFC 9700
  // §4.14.2) — a false logout, traded for a faster error. A timeout cannot make a rotation not happen; it
  // can only make sure we never learn its result. So the call — body included — is bounded only by the
  // runtime's own transport timeouts (undici: 300 s for headers, 300 s between body chunks) and the
  // single-flight backstop; the CALLERS waiting on it are bounded separately (`REFRESH_WAIT_MS`), and a
  // hung lukk costs one connection per SESSION, not per request: every caller on it shares this one call.
  let res: Response
  try {
    res = await fetch(target, {
      method: 'POST',
      headers,
      body: JSON.stringify({ refresh_token: refreshToken }),
      // Never follow an upstream 3xx: a 307/308 preserves this POST body, which would
      // re-send the rotating refresh token to the redirect host (CWE-918/200). An opaque
      // redirect is not `ok`, so it falls through to the not-ok branch below.
      redirect: 'manual',
    })
  }
  catch {
    // lukk unreachable, or the connection dropped mid-request: an outage, not a verdict on the token.
    // It threw straight out of the handler as a 500 before. (If lukk did rotate it, the next refresh
    // replays it inside the grace window and gets a sibling.)
    return { pair: null, retryable: true }
  }

  // Only lukk actually rejecting the token ends the session. Anything else — a throttle, an outage,
  // a redirect we refused — left it unconsumed, so report it retryable and keep the session.
  if (!res.ok) {
    // Unread, so cancelled: left alone it holds the connection until the runtime collects it.
    void res.body?.cancel().catch(() => {})
    return { pair: null, retryable: res.status !== 401 && res.status !== 403 }
  }

  const pair = await res.json() as { access_token: string, refresh_token?: string, expires_in?: number }

  // No fallback to the token just sent: lukk has consumed it. Kept, the next refresh would replay it
  // past the grace window and reuse detection would revoke the family as stolen. Without a new one the
  // session ends when this access token does.
  return { pair: { access: pair.access_token, refresh: pair.refresh_token }, expiresIn: pair.expires_in, retryable: false }
}

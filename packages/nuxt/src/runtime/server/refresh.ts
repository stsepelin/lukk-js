import { isSessionEnded, sessionEnded, sessionKey } from './ended-sessions'
import { forgetHeldRefresh, type Held, heldRefresh } from './held-refresh'
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
// The rotations that landed with nobody left to receive them live in `held-refresh.ts`.

/** A refresh on the wire, and how many callers are still waiting on it. */
interface Flight {
  run: Promise<RefreshResult>
  waiting: number
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
 * refresh if it is still out, and adopts the outcome if it landed meanwhile (`REFRESH_HOLD_MS`) — neither
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
 * How long a rotation that landed with nobody left to receive it is kept for its FIRST taker.
 *
 * Dropping it was a release blocker: lukk had rotated, the session still held the consumed token, and its
 * next refresh came at the user's next action — not after any `Retry-After` — so it replayed that token
 * long past the grace window, and reuse detection revoked the family as stolen. Kept, the next request
 * still presenting that token (only that token, for that session) adopts and seals the rotated pair.
 *
 * Only for as long as it can still help, and no longer than it must: ten minutes untaken (a replay that
 * late revokes the family whatever we do); `REFRESH_STRAGGLER_MS` once taken; at once when the session
 * presents any other token (it has moved on — the pair handed out, or a newer one) or ends.
 *
 * The consumed token is kept as it is, not as a digest: comparing it synchronously leaves no `await`
 * between "nothing held, no refresh out" and starting one, in which a concurrent request could replay it.
 * It is spent anyway, and anyone who could present it already holds the sealed cookie it came from.
 */
export const REFRESH_HOLD_MS = 10 * 60_000

/**
 * How long a held rotation stays adoptable once taken: for the burst of requests that were already out
 * with the old cookie (a page coming back fires several at once). At least a caller's wait plus its
 * `Retry-After`, and comparable to lukk's own grace window. Past it, a request presenting the consumed
 * token is not this browser catching up — it is an old cookie somewhere else, and lukk's reuse detection
 * is the right answer to it.
 */
export const REFRESH_STRAGGLER_MS = 30_000
// An accepted limit: the FIRST taker's response can be lost (a navigation aborts it), leaving the browser on
// the consumed token after the window has closed. Its replay then revokes the family — the same exposure an
// ordinary rotation has when the response carrying it is lost. Holding longer would widen the window in
// which an old cookie somewhere else is answered with a live pair.

/** Single-flight the server-side refresh per session, returning the rotation outcome. */
export function refreshOnce(session: { id?: string, data: TokenSession }, baseURL: string, clientIp = ''): Promise<RefreshResult> {
  const token = session.data.refresh!
  // Keyed by the session's own `sid`, not h3's id: a sign-in re-seals the NEW session under the old h3
  // id, so a refresh for it would otherwise join one still out for the session it replaced, and seal
  // that session's tokens under the new one.
  const id = sessionKey(session)
  // No id → don't key the map (an empty key would collapse distinct sessions).
  if (!id) return waitOn({ run: rawRefresh(token, baseURL, clientIp), waiting: 0 })

  const held = heldRefresh.get(id)
  if (held?.consumed === token) return Promise.resolve(take(id, held))
  // Any other token: the session has moved on, and the held rotation with it — except the session's own
  // chain, presented while the straggler window is open. The token the hold handed out is the taker
  // refreshing (an access token that ran out while the hold waited comes back already expired), and the
  // burst it belongs to may still have requests with the consumed token on the way; dropped, they reached
  // lukk long past its grace window. The window's own timer ends it. (Only a rotation that produced a pair
  // is ever held.)
  const handedOut = held?.taken === true && held.result.pair!.refresh === token
  if (!handedOut && !(held?.taken && held.superseded.has(token))) forgetHeldRefresh(id)

  // Joined only by a request presenting the token it is rotating — the flight is keyed by both. One with
  // another token is lukk's to rule on: joined, it was handed a pair its own token never earned.
  const flight = inflightRefresh.get(flightKey(id, token)) ?? fly(id, token, baseURL, clientIp)
  if (handedOut) void flight.run.then(result => forwardHeld(held!, token, result))
  return waitOn(flight)
}

/**
 * The session rotated the token a hold handed out: forward the hold to that rotation, so a straggler still
 * presenting the consumed token adopts the CURRENT pair. Left on the handed-out one, it re-sealed a token
 * lukk had just rotated, and the browser's next refresh replayed it — past lukk's grace window, as long as
 * the straggler window itself, it revoked the family. The window is never extended: the timer set at the
 * first taking still ends it. A session that ended meanwhile has no hold left to forward: `markSessionEnded`
 * let it go, so forwarding the detached object reaches no request. Every forward for one rotation runs
 * when it lands, with the same result, so a second one changes nothing.
 */
function forwardHeld(held: Held, rotated: string, result: RefreshResult): void {
  if (!result.pair) return
  held.superseded.add(rotated)
  held.result = result
  held.landedAt = Date.now()
}

/** A session's refresh of one particular token. */
function flightKey(id: string, token: string): string {
  return `${id}\n${token}`
}

/** Start the session's refresh, and keep its outcome should it land with nobody waiting. */
function fly(id: string, token: string, baseURL: string, clientIp: string): Flight {
  const flight: Flight = { run: rawRefresh(token, baseURL, clientIp), waiting: 0 }
  const key = flightKey(id, token)
  inflightRefresh.set(key, flight)
  // Only ever THIS entry: once the backstop has dropped it, a newer refresh may hold the key.
  const forget = () => {
    clearTimeout(backstop)
    if (inflightRefresh.get(key) === flight) inflightRefresh.delete(key)
  }
  const backstop = unref(setTimeout(forget, REFRESH_INFLIGHT_MAX_MS))
  // Before `forget`, synchronously: there is no moment when the session has neither a flight nor the
  // outcome, in which a request with the old token could start a replay. Never for a session that ended
  // while it was out — a logout or sign-in lets go of a held one too (`markSessionEnded`).
  flight.run.then((result) => {
    // Nor when it rotated the token a hold handed out: `forwardHeld` moves that hold on instead, keeping
    // the straggler window it already has — a fresh hold would drop the consumed token's stragglers.
    if (result.pair && flight.waiting === 0 && !isSessionEnded(id) && heldRefresh.get(id)?.result.pair!.refresh !== token) hold(id, token, result)
    forget()
  }, forget)
  return flight
}

function hold(id: string, consumed: string, result: RefreshResult): void {
  const held: Held = { consumed, result, landedAt: Date.now(), taken: false, superseded: new Set() }
  held.timer = unref(setTimeout(() => forgetHeldRefresh(id, held), REFRESH_HOLD_MS))
  heldRefresh.set(id, held)
  // And not one another instance ended: the shared store answers asynchronously, so it is let go after.
  void sessionEnded(id).then((ended) => {
    if (ended) forgetHeldRefresh(id, held)
  })
}

/** Adopt a held rotation: its pair, with what is LEFT of the access token's lifetime. */
function take(id: string, held: Held): RefreshResult {
  if (!held.taken) {
    held.taken = true
    clearTimeout(held.timer)
    held.timer = unref(setTimeout(() => forgetHeldRefresh(id, held), REFRESH_STRAGGLER_MS))
  }
  const { expiresIn, ...rest } = held.result
  if (expiresIn === undefined) return rest
  return { ...rest, expiresIn: Math.max(0, expiresIn - Math.floor((Date.now() - held.landedAt) / 1000)) }
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

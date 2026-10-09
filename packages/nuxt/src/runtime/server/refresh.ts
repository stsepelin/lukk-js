import { sessionKey } from './ended-sessions'
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

/**
 * Rotations that landed after every caller waiting on them had given up — see `REFRESH_HOLD_MS`. Keyed by
 * session, and adoptable only by a request presenting the very token that rotation consumed.
 *
 * **Per process**, like the single-flight above. A multi-instance BFF without sticky sessions does not
 * share it: a retry that lands on another instance replays the consumed token, and lukk's grace window is
 * then all that stands between it and a family revoke.
 */
const heldRefresh: Map<string, Held> = ((globalThis as { __lukkHeldRefresh?: Map<string, Held> }).__lukkHeldRefresh ??= new Map())

/** A refresh on the wire, and how many callers are still waiting on it. */
interface Flight {
  run: Promise<RefreshResult>
  waiting: number
}

/** A rotation nobody received: its outcome, and the digest of the refresh token it consumed. */
interface Held {
  token: Promise<string>
  result: RefreshResult
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
 * How long a rotation that landed with nobody left to receive it is kept for the session's next refresh.
 *
 * Dropping it was a release blocker: lukk had rotated, the session still held the consumed token, and its
 * next refresh came at the user's next action — not after any `Retry-After` — so it replayed that token
 * long past the grace window, and reuse detection revoked the family as stolen. Kept, the next request
 * still presenting that token (and only one presenting it: the key is the session, the check a digest of
 * the token) adopts and seals the rotated pair instead. Every request that does, not just the first — a
 * page coming back fires several at once with the same old cookie. Ten minutes, then let go: a replay
 * that late revokes the family whatever we do, and a pair should not sit in memory longer than it helps.
 */
export const REFRESH_HOLD_MS = 10 * 60_000

/** Single-flight the server-side refresh per session, returning the rotation outcome. */
export function refreshOnce(session: { id?: string, data: TokenSession }, baseURL: string, clientIp = ''): Promise<RefreshResult> {
  const token = session.data.refresh!
  // Keyed by the session's own `sid`, not h3's id: a sign-in re-seals the NEW session under the old h3
  // id, so a refresh for it would otherwise join one still out for the session it replaced, and seal
  // that session's tokens under the new one.
  const id = sessionKey(session)
  // No id → don't key the map (an empty key would collapse distinct sessions).
  if (!id) return waitOn({ run: rawRefresh(token, baseURL, clientIp), waiting: 0 })
  const existing = inflightRefresh.get(id)
  if (existing) return waitOn(existing)

  const held = heldRefresh.get(id)
  if (!held) return waitOn(fly(id, token, baseURL, clientIp))
  return Promise.all([held.token, digest(token)]).then(([consumed, presented]) => {
    if (consumed === presented) return held.result
    // A different token: the session has moved on. Its own refresh — joined if one started meanwhile.
    return waitOn(inflightRefresh.get(id) ?? fly(id, token, baseURL, clientIp))
  })
}

/** Start the session's refresh, and keep its outcome should it land with nobody waiting. */
function fly(id: string, token: string, baseURL: string, clientIp: string): Flight {
  const flight: Flight = { run: rawRefresh(token, baseURL, clientIp), waiting: 0 }
  inflightRefresh.set(id, flight)
  // Only ever THIS entry: once the backstop has dropped it, a newer refresh may hold the key.
  const forget = () => {
    clearTimeout(backstop)
    if (inflightRefresh.get(id) === flight) inflightRefresh.delete(id)
  }
  const backstop = unref(setTimeout(forget, REFRESH_INFLIGHT_MAX_MS))
  // Before `forget`, synchronously: there is no moment when the session has neither a flight nor the
  // outcome, in which a request with the old token could start a replay.
  flight.run.then((result) => {
    if (result.pair && flight.waiting === 0) hold(id, digest(token), result)
    forget()
  }, forget)
  return flight
}

function hold(id: string, token: Promise<string>, result: RefreshResult): void {
  const held: Held = { token, result }
  heldRefresh.set(id, held)
  unref(setTimeout(() => {
    if (heldRefresh.get(id) === held) heldRefresh.delete(id)
  }, REFRESH_HOLD_MS))
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

/** A refresh token's SHA-256, as a string — compared, never stored as the token itself. */
async function digest(token: string): Promise<string> {
  // One character per byte: injective, so two tokens never compare equal unless their digests do.
  return String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))))
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

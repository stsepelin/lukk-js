import { defineEventHandler, getRequestHeader, getRequestIP, proxyRequest, setResponseStatus } from 'h3'
import { useRuntimeConfig } from '#imports'
import { LUKK_BFF_PREFIX } from '../shared'
import { isForeignOrigin, resolveTarget } from './proxy-utils'
import { getLukkAccessToken } from './utils/session'

// Browser-settable forwarding / client-IP headers. We neutralise these so a script
// can't spoof `$request->ip()` upstream (defeating lukk's per-IP throttling and
// poisoning IP logs / absolute-URL generation) when Laravel trusts the Nitro hop.
const SPOOFABLE_FORWARDING = {
  'x-forwarded-host': '',
  'x-forwarded-proto': '',
  'x-forwarded-port': '',
  'forwarded': '',
  'x-real-ip': '',
  'x-client-ip': '',
  'true-client-ip': '',
  'cf-connecting-ip': '',
  'fastly-client-ip': '',
  'x-cluster-client-ip': '',
} as const

/**
 * Optional BFF app-API proxy. Forwards same-origin `${apiPath}/**` requests to
 * the FIXED `apiTarget` (your Laravel API), injecting the lukk access token from
 * the sealed session **server-side** — so the browser authenticates to your own
 * API without ever holding a token, exactly like the lukk `/auth` routes.
 *
 * Security: the target is fixed config (never request-derived) and contained by
 * `resolveTarget` (SSRF-safe); non-GET requests with a foreign Origin are rejected
 * (CSRF); the inbound `Cookie` (the sealed session), any browser `Authorization`,
 * and spoofable forwarding/IP headers are stripped (only a trusted `X-Forwarded-For`
 * is set); and `/api/_lukk/**` is never proxied here.
 */
export default defineEventHandler(async (event) => {
  const { apiPath, apiTarget, apiForceJson } = useRuntimeConfig(event).lukk as { apiPath: string, apiTarget: string, apiForceJson: boolean }

  if (isForeignOrigin(event)) {
    setResponseStatus(event, 403)
    return { message: 'Cross-origin request rejected.' }
  }

  const queryAt = event.path.indexOf('?')
  const path = queryAt === -1 ? event.path : event.path.slice(0, queryAt)
  const query = queryAt === -1 ? '' : event.path.slice(queryAt)

  // Defence-in-depth: the lukk BFF routes belong to the other proxy.
  if (path === LUKK_BFF_PREFIX || path.startsWith(`${LUKK_BFF_PREFIX}/`)) {
    setResponseStatus(event, 404)
    return { message: 'Not found.' }
  }

  // Defensive: only proxy paths actually under the mount (Nitro's `/**` normally
  // guarantees this, but don't trust the slice blindly).
  if (path !== apiPath && !path.startsWith(`${apiPath}/`)) {
    setResponseStatus(event, 404)
    return { message: 'Not found.' }
  }

  // Subpath after the mount, contained to the fixed target (`resolveTarget` normalizes
  // `..`/`%2e%2e` and rejects anything escaping the target's origin + path).
  const base = resolveTarget(apiTarget, path.slice(apiPath.length) || '/')
  if (!base) {
    setResponseStatus(event, 400)
    return { message: 'Invalid path.' }
  }

  // Inject the bearer server-side; strip the inbound Cookie + Authorization + any
  // spoofable forwarding headers, and stamp a trusted client IP. `streamRequest`
  // pipes the body through instead of buffering it (large uploads stay cheap).
  const access = await getLukkAccessToken(event)
  // Force `Accept: application/json` so the JSON API content-negotiates correctly:
  // Laravel's `expectsJson()` is then true, yielding clean 401/422 JSON instead of
  // eagerly resolving `route('login')` (a 500 when there's no `login` route). Opt out
  // to forward the browser's Accept (for a route under `path` that serves non-JSON).
  const accept = apiForceJson ? 'application/json' : (getRequestHeader(event, 'accept') ?? '')
  return proxyRequest(event, base + query, {
    streamRequest: true,
    headers: {
      'accept': accept,
      'cookie': '',
      'authorization': access ? `Bearer ${access}` : '',
      'x-forwarded-for': getRequestIP(event, { xForwardedFor: false }) ?? '',
      ...SPOOFABLE_FORWARDING,
    },
    // The proxy injects a bearer — it is not a cookie/cache passthrough. Strip any
    // upstream Set-Cookie (no shadowing of `__Host-lukk-session`) and keep the
    // (authenticated) response out of shared caches.
    onResponse(ev) {
      ev.node.res.removeHeader('set-cookie')
      ev.node.res.setHeader('cache-control', 'private, no-store')
    },
  })
})

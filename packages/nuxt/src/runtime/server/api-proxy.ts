import { defineEventHandler, getRequestHeader, getRequestIP, proxyRequest, setResponseStatus } from 'h3'
import { useRuntimeConfig } from '#imports'
import { LUKK_BFF_PREFIX } from '../shared'
import { isForeignOrigin, resolveTarget } from './proxy-utils'
import { getLukkAccessToken } from './utils/session'

// Browser-settable forwarding / client-IP headers, neutralised so a script can't
// spoof `$request->ip()` upstream. See docs/transport-modes.md.
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
 * Optional BFF app-API proxy. Forwards same-origin `${apiPath}/**` to the fixed
 * `apiTarget` (your Laravel API), injecting the lukk access token from the sealed
 * session server-side — so the browser authenticates without ever holding a token.
 *
 * Security (SSRF/CSRF containment, header stripping) is documented in
 * docs/transport-modes.md.
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

  // The lukk BFF routes belong to the other proxy.
  if (path === LUKK_BFF_PREFIX || path.startsWith(`${LUKK_BFF_PREFIX}/`)) {
    setResponseStatus(event, 404)
    return { message: 'Not found.' }
  }

  // Only proxy paths under the mount.
  if (path !== apiPath && !path.startsWith(`${apiPath}/`)) {
    setResponseStatus(event, 404)
    return { message: 'Not found.' }
  }

  // Subpath after the mount, contained to the fixed target by `resolveTarget`.
  const base = resolveTarget(apiTarget, path.slice(apiPath.length) || '/')
  if (!base) {
    setResponseStatus(event, 400)
    return { message: 'Invalid path.' }
  }

  // Inject the bearer server-side; strip inbound Cookie/Authorization + spoofable
  // headers; `streamRequest` pipes the body through instead of buffering it.
  const access = await getLukkAccessToken(event)
  // Force `Accept: application/json` so auth/validation errors render as JSON (see
  // docs/transport-modes.md). Opt out to forward the browser's Accept for non-JSON routes.
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
    // Not a cookie/cache passthrough: strip upstream Set-Cookie and keep the
    // authenticated response out of shared caches.
    onResponse(ev) {
      ev.node.res.removeHeader('set-cookie')
      ev.node.res.setHeader('cache-control', 'private, no-store')
    },
  })
})

import type { H3Event } from 'h3'
import { getCookie, unsealSession } from 'h3'
import { useRuntimeConfig } from '#imports'
import { LUKK_SESSION_COOKIE } from '../../shared'

/**
 * READ-ONLY access to the BFF sealed token session, for your own server routes.
 *
 * Unlike h3's `useSession`, this NEVER creates or slides the session cookie: it
 * reads the request cookie and unseals it in place (`unsealSession` is pure). So
 * it is safe on unauthenticated requests — it returns `{ access: null }` and
 * queues no `Set-Cookie`, which would otherwise collide with `proxyRequest`
 * streaming the upstream response (a 500).
 *
 * Server-only: it returns just the access token, never the refresh token.
 */
export async function useLukkSession(event: H3Event): Promise<{ access: string | null }> {
  return { access: await getLukkAccessToken(event) }
}

/** The current user's lukk access token from the sealed BFF session, or null. */
export async function getLukkAccessToken(event: H3Event): Promise<string | null> {
  const { sessionPassword } = useRuntimeConfig(event).lukk as { sessionPassword?: string }
  const sealed = getCookie(event, LUKK_SESSION_COOKIE)
  if (!sealed || !sessionPassword) return null
  try {
    const unsealed = await unsealSession(event, { password: sessionPassword, name: LUKK_SESSION_COOKIE }, sealed)
    const access = (unsealed as { data?: { access?: unknown } }).data?.access
    return typeof access === 'string' ? access : null
  }
  catch {
    // Tampered, expired, or wrong-secret seal → treat as no session.
    return null
  }
}

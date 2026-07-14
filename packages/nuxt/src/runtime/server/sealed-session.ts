import type { H3Event } from 'h3'
import { getCookie, unsealSession } from 'h3'
import type { TokenSession } from './utils/refresh'

/**
 * Read-only unseal of the sealed BFF token session (access + refresh + confirmation).
 *
 * Unlike h3's `useSession`, this NEVER creates or slides the session cookie: it reads the request
 * cookie and unseals it in place (`unsealSession` is pure). So it is safe on an unauthenticated
 * request and alongside a streamed/proxied response — it queues no `Set-Cookie` (which would
 * otherwise collide with the streamed reply). A missing cookie, an absent password, or a
 * tampered/expired/wrong-secret seal all yield `{}`.
 *
 * Server-only, and it returns the refresh token — never hand that back to a client. It is
 * deliberately NOT in `server/utils` (so it is not auto-imported); consumers get only the
 * access-token view via `getLukkAccessToken`.
 */
export async function readSealedSession(event: H3Event, password: string | undefined, name: string): Promise<TokenSession> {
  const sealed = getCookie(event, name)
  if (!sealed || !password) return {}
  try {
    const unsealed = await unsealSession(event, { password, name }, sealed)
    return (unsealed as { data?: TokenSession }).data ?? {}
  }
  catch {
    return {}
  }
}

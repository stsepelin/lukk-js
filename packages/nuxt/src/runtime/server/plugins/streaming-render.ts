import { sessionCookieName } from '../../shared'
import { accessExpired } from '../access-token'
import { readSealedSession } from '../sealed-session'
import { defineNitroPlugin, useRuntimeConfig } from '#imports'

interface RenderRouteContext { canStream?: boolean, prefersStream?: boolean }
type RenderRouteHook = (context: RenderRouteContext, meta: { event: Parameters<typeof readSealedSession>[0] }) => Promise<void>

/**
 * Don't stream a page whose session has to be refreshed while it renders (Nuxt 4's
 * `experimental.ssrStreaming`).
 *
 * A streamed page sends its headers after its first chunk, which renders components after the session
 * plugin ran — and nothing runs in between. A session re-sealed during that render could not be withheld
 * if a sign-in or logout replaced it meanwhile. Skipping the refresh instead was worse: every server-side
 * app-API fetch in that render then refreshed on its own, replaying a consumed refresh token into
 * siblings and, past the grace window, a false theft report.
 *
 * So such a page opts out of streaming — `prefersStream`, Nuxt's own switch, decided before the app
 * renders — and takes the ordinary path, where the re-seal is checked before the headers go out. A page
 * with a still-valid token, or no session, streams as usual. (A hook of the app's own that sets
 * `prefersStream` back afterwards takes that protection away for its routes.)
 */
export default defineNitroPlugin((nitroApp) => {
  const hooks = nitroApp.hooks as unknown as { hook: (name: string, fn: RenderRouteHook) => void }

  hooks.hook('render:route', async (context, { event }) => {
    if (!context.canStream || !context.prefersStream) return

    const { sessionPassword, cookieSecure, cookieNamespace } = (useRuntimeConfig(event).lukk ?? {}) as { sessionPassword?: string, cookieSecure?: boolean, cookieNamespace?: string }
    const sealed = await readSealedSession(event, sessionPassword, sessionCookieName(cookieSecure !== false, cookieNamespace))

    if (sealed.access && sealed.refresh && accessExpired(sealed.access)) context.prefersStream = false
  })
})

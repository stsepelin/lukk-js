import type { H3Event } from 'h3'
import { withholdSignedOutCookie } from '../logout-note'
import { defineNitroPlugin } from '#imports'

type Hook = (first: unknown, second: unknown) => Promise<void>

/**
 * The last check on a response whose request finished a logout (see `finish-logout`), right before its
 * headers go out.
 *
 * That logout ran before the route, and its answer — the cookie saying this browser is signed out — leaves
 * with the response, after the whole render, a server-side redirect, an API route's work. A sign-in in
 * another tab that completed meanwhile means that answer is about a session the browser no longer holds, and
 * a response a route rule CACHES would carry it to other visitors. Either way it stays here.
 *
 * Two hooks, because neither sees every response: Nitro's `beforeResponse` runs for whatever a handler
 * returns — pages, redirects, API routes, errors h3 renders — and `render:html` for a page Nuxt renders
 * through a cached route rule, whose own response `beforeResponse` sees only by proxy. The app-API proxy
 * streams its reply and checks in its own `onResponse`. A streamed page (Nuxt's `ssrStreaming`) sends its
 * headers before either: there the window is its first chunk.
 */
export default defineNitroPlugin((nitroApp) => {
  const hooks = nitroApp.hooks as unknown as { hook: (name: string, fn: Hook) => void }

  hooks.hook('beforeResponse', async event => withholdSignedOutCookie(event as H3Event))
  hooks.hook('render:html', async (_html, meta) => withholdSignedOutCookie((meta as { event: H3Event }).event))
})

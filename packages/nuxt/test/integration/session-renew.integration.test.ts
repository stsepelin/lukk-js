import type { Server } from 'node:http'
import { createServer } from 'node:http'
import { createApp, defineEventHandler, getProxyRequestHeaders, toNodeListener, unsealSession, useSession } from 'h3'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
// End to end, with `ssrHydrate: false`: the REAL render marker and renewal plugins run against a page
// request, a render's own request goes through the REAL app-API proxy the way Nuxt's `event.$fetch` sends
// it (the page request's headers, copied), and lukk and the app API are throwaway servers over real sockets.
import { __test } from '../mocks/imports'
import apiProxy from '../../src/runtime/server/api-proxy'
import marker from '../../src/runtime/plugins/render-marker.server'
import renew from '../../src/runtime/plugins/session-renew.server'
import { refreshJournals } from '../../src/runtime/server/refresh-journal'
import { LUKK_SESSION_COOKIE } from '../../src/runtime/shared'

const SESSION_PASSWORD = 'p'.repeat(32)
const SID = `render-${Math.random()}`
const port = (s: Server) => (s.address() as { port: number }).port
const jwt = (exp: number) => {
  const seg = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${seg({ alg: 'HS256' })}.${seg({ exp })}.sig`
}
const freshAccess = jwt(Math.floor(Date.now() / 1000) + 900)

let lukk: Server
let upstream: Server
let app: Server
let appURL = ''
let refreshCalls = 0
let upstreamBearer: string | undefined
let inRender: { status: number, setCookie: string[], linkTakenDuringRender: boolean | undefined } | undefined
let linkTakenAfterRender: boolean | undefined

beforeAll(async () => {
  lukk = createServer((req, res) => {
    if (req.url === '/refresh') refreshCalls++
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ access_token: freshAccess, refresh_token: 'rt1', expires_in: 900 }))
  })
  await new Promise<void>(r => lukk.listen(0, '127.0.0.1', r))
  upstream = createServer((req, res) => {
    upstreamBearer = req.headers.authorization
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ id: 1 }))
  })
  await new Promise<void>(r => upstream.listen(0, '127.0.0.1', r))

  __test.runtimeConfig.lukk = {
    apiPath: '/api',
    apiTarget: `http://127.0.0.1:${port(upstream)}`,
    apiForceJson: true,
    baseURL: `http://127.0.0.1:${port(lukk)}`,
    sessionPassword: SESSION_PASSWORD,
  } as unknown as Record<string, unknown>

  const h3 = createApp()
  h3.use('/__mint', defineEventHandler(async (event) => {
    const s = await useSession(event, { password: SESSION_PASSWORD, name: LUKK_SESSION_COOKIE, cookie: { sameSite: 'strict', secure: true, httpOnly: true, path: '/' } })
    await s.update({ access: jwt(Math.floor(Date.now() / 1000) - 10), refresh: 'rt0', sid: SID })
    return { ok: true }
  }))
  // A page render, as Nuxt runs one: the server plugins, then the app's components fetching, then the
  // render hooks — and only then does the page response, with its cookies, leave.
  h3.use('/page', defineEventHandler(async (event) => {
    const hooks: Record<string, (() => unknown)[]> = {}
    const nuxtApp = {
      payload: { serverRendered: true },
      ssrContext: { event },
      hooks: { hook: (name: string, fn: () => unknown) => { (hooks[name] ??= []).push(fn) } },
    }
    ;(marker as unknown as (app: unknown) => void)(nuxtApp)
    await (renew as unknown as (app: unknown) => Promise<void>)(nuxtApp)

    // `event.$fetch('/api/me')` / SSR `useFetch`: the page request's headers, copied.
    const res = await fetch(`${appURL}/api/me`, { headers: getProxyRequestHeaders(event) })
    await res.text()
    inRender = { status: res.status, setCookie: res.headers.getSetCookie(), linkTakenDuringRender: refreshJournals.get(SID)?.get('rt0')?.taken }

    for (const fn of hooks['app:rendered'] ?? []) await fn()
    linkTakenAfterRender = refreshJournals.get(SID)?.get('rt0')?.taken
    return '<html>rendered</html>'
  }))
  h3.use(apiProxy)
  app = createServer(toNodeListener(h3))
  await new Promise<void>(r => app.listen(0, '127.0.0.1', r))
  appURL = `http://127.0.0.1:${port(app)}`
})

afterAll(() => { lukk?.close(); upstream?.close(); app?.close() })

describe('renewal before a render without hydration (ssrHydrate: false)', () => {
  it('renews once, before the render — its own requests carry the fresh token, and the cookie leaves with the page', async () => {
    const sealed = (await fetch(`${appURL}/__mint`)).headers.get('set-cookie')!.split(';')[0]!
    refreshCalls = 0

    const page = await fetch(`${appURL}/page`, { headers: { cookie: sealed } })
    await page.text()

    expect(refreshCalls).toBe(1) // the renewal alone — the in-render request did not rotate again
    expect(inRender).toEqual({ status: 200, setCookie: [], linkTakenDuringRender: false })
    expect(upstreamBearer).toBe(`Bearer ${freshAccess}`)

    // The rotated session reaches the browser with the page, not with the in-render response.
    const cookie = page.headers.getSetCookie().find(c => c.startsWith(`${LUKK_SESSION_COOKIE}=`))!
    const seal = decodeURIComponent(cookie.split(';')[0]!.slice(LUKK_SESSION_COOKIE.length + 1))
    const session = await unsealSession({} as never, { password: SESSION_PASSWORD }, seal)
    expect((session.data as { refresh?: string }).refresh).toBe('rt1')
    expect(page.headers.get('cache-control')).toBe('no-store')

    // Delivered when the page left: the link is taken then, and not before.
    expect(linkTakenAfterRender).toBe(true)
  })
})

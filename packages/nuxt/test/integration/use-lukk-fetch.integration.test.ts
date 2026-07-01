import type { Server } from 'node:http'
import { createServer } from 'node:http'
import { ofetch } from 'ofetch'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
// REAL ofetch against a throwaway upstream. The mocked unit tests can't catch that a
// relative URL is unfetchable server-side — which is exactly why server-BFF routes
// through Nuxt's request-aware fetch instead of plain ofetch.
import { createLukkFetch } from '../../src/runtime/utils/create-lukk-fetch'

let upstream: Server
let origin = ''
let received: { path?: string, cookie?: string, accept?: string, auth?: string } = {}

const port = (s: Server) => (s.address() as { port: number }).port

beforeAll(async () => {
  upstream = createServer((req, res) => {
    received = { path: req.url, cookie: req.headers.cookie, accept: req.headers.accept, auth: req.headers.authorization }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ id: 1 }))
  })
  await new Promise<void>(r => upstream.listen(0, '127.0.0.1', r))
  origin = `http://127.0.0.1:${port(upstream)}`
})

afterAll(() => { upstream?.close() })

function ssrFetch(baseURL: string) {
  return createLukkFetch({
    baseURL,
    isServer: true,
    canRefresh: false,
    getCookieHeader: () => '__Host-lukk-session=sealed',
    getBearer: () => null,
    refresh: async () => null,
    onRedirect: () => {},
    fetchImpl: ofetch,
  })
}

describe('useLukkFetch SSR (real ofetch + upstream)', () => {
  it('forwards the session cookie server-side against an absolute base (direct mode / resolved)', async () => {
    const data = await ssrFetch(`${origin}/api`)('/me') // absolute base — as in direct mode

    expect(data).toEqual({ id: 1 })
    expect(received.path).toBe('/api/me')
    expect(received.cookie).toBe('__Host-lukk-session=sealed') // the SSR fix: cookie transits
    expect(received.accept).toBe('application/json')
    expect(received.auth).toBeUndefined() // BFF: no bearer
  })

  it('a RELATIVE base is unfetchable by plain ofetch server-side — why server-BFF uses the request-aware fetch', async () => {
    await expect(ssrFetch('/api')('/me')).rejects.toThrow(/parse URL|Invalid URL/i)
  })
})

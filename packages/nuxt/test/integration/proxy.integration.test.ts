import type { Server } from 'node:http'
import { createServer, request } from 'node:http'
import { createApp, defineEventHandler, toNodeListener, useSession } from 'h3'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
// REAL h3 (no vi.mock here) + the real proxy handler, driven over real sockets
// against a throwaway upstream — so multipart upload + binary download transit is
// genuinely exercised, not just the handler's header config.
import { __test } from '../mocks/imports'
import handler from '../../src/runtime/server/api-proxy'
import { LUKK_SESSION_COOKIE } from '../../src/runtime/shared'

let upstream: Server
let auth: Server
let proxy: Server
let proxyURL = ''
let received: { method?: string, contentType?: string, accept?: string, authorization?: string, xForwardedFor?: string, visitorCountry?: string, body: Buffer } = { body: Buffer.alloc(0) }
let refreshCalls = 0

const port = (s: Server) => (s.address() as { port: number }).port
const SESSION_PASSWORD = 'p'.repeat(32)
// A minimal, already-expired access JWT (exp in the past) → proactive refresh fires.
const expiredJwt = () => {
  const seg = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${seg({ alg: 'HS256' })}.${seg({ exp: Math.floor(Date.now() / 1000) - 10 })}.sig`
}

beforeAll(async () => {
  // Upstream "Laravel": echoes the upload/bearer; serves a binary for /download.
  upstream = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c as Buffer))
    req.on('end', () => {
      if (req.url?.includes('/download')) {
        res.setHeader('content-type', 'application/pdf')
        res.setHeader('content-disposition', 'attachment; filename="f.pdf"')
        res.end(Buffer.from('%PDF-1.4 binary', 'utf8'))
        return
      }
      if (req.url?.includes('/set-cookies')) {
        // An allow-listed cookie, a non-listed one, and a forged session cookie.
        res.setHeader('set-cookie', ['locale=en; Path=/', 'tracking=xyz; Path=/', '__Host-lukk-session=FORGED; Path=/'])
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: true }))
        return
      }
      received = { method: req.method, contentType: req.headers['content-type'], accept: req.headers.accept, authorization: req.headers.authorization, xForwardedFor: req.headers['x-forwarded-for'] as string | undefined, visitorCountry: req.headers['x-visitor-country'] as string | undefined, body: Buffer.concat(chunks) }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ok: true }))
    })
  })
  await new Promise<void>(r => upstream.listen(0, '127.0.0.1', r))

  // Fake lukk auth server: the proactive-refresh `/refresh` endpoint.
  auth = createServer((req, res) => {
    if (req.url === '/refresh') refreshCalls++
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ access_token: 'new-tok', refresh_token: 'rt2', expires_in: 900 }))
  })
  await new Promise<void>(r => auth.listen(0, '127.0.0.1', r))

  __test.runtimeConfig.lukk = {
    apiPath: '/api',
    apiTarget: `http://127.0.0.1:${port(upstream)}`,
    apiForceJson: true,
    baseURL: `http://127.0.0.1:${port(auth)}`,
    sessionPassword: SESSION_PASSWORD,
    apiForwardSetCookie: ['locale'],
  } as unknown as Record<string, unknown>

  const app = createApp()
  // Test-only endpoint: seal a real session cookie (expired access + refresh token),
  // so the proxy round-trips genuine iron-sealed session crypto — not a mock.
  app.use('/__mint', defineEventHandler(async (event) => {
    const s = await useSession(event, { password: SESSION_PASSWORD, name: LUKK_SESSION_COOKIE, cookie: { sameSite: 'strict', secure: true, httpOnly: true, path: '/' } })
    await s.update({ access: expiredJwt(), refresh: 'rt' })
    return { ok: true }
  }))
  app.use(handler)
  proxy = createServer(toNodeListener(app))
  await new Promise<void>(r => proxy.listen(0, '127.0.0.1', r))
  proxyURL = `http://127.0.0.1:${port(proxy)}`
})

afterAll(() => { upstream?.close(); auth?.close(); proxy?.close() })

describe('api-proxy integration (real h3 + upstream)', () => {
  it('forwards a multipart/form-data upload intact', async () => {
    const form = new FormData()
    form.append('file', new Blob(['hello-bytes'], { type: 'text/plain' }), 'hello.txt')
    form.append('field', 'value')

    const res = await fetch(`${proxyURL}/api/upload`, { method: 'POST', body: form })

    expect(res.status).toBe(200)
    expect(received.method).toBe('POST')
    expect(received.contentType).toMatch(/^multipart\/form-data; boundary=/) // boundary preserved
    expect(received.accept).toBe('application/json') // forceJson stamped server-side
    expect(received.body.toString()).toContain('hello-bytes') // file bytes transited
    expect(received.body.toString()).toContain('value') // field transited
  })

  it('proactively refreshes an expired session, injects the new bearer, and rotates the session cookie', async () => {
    // Mint a real sealed session carrying an expired access token + a refresh token.
    const mint = await fetch(`${proxyURL}/__mint`)
    const sealed = mint.headers.get('set-cookie')!.split(';')[0] // NAME=<sealed>
    expect(sealed).toContain(LUKK_SESSION_COOKIE)
    refreshCalls = 0

    const res = await fetch(`${proxyURL}/api/me`, { headers: { cookie: sealed } })

    expect(res.status).toBe(200)
    expect(refreshCalls).toBe(1) // one server-side refresh
    expect(received.authorization).toBe('Bearer new-tok') // the freshly-rotated access token
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    // The rotated session cookie survives the streamed proxy response...
    const rotated = res.headers.get('set-cookie')
    expect(rotated).toContain(LUKK_SESSION_COOKIE)
    expect(rotated).not.toBe(sealed) // ...and it's a new seal, not the minted one
  })

  it('never mints a session cookie for a garbage/expired seal (no 500, no empty-session overwrite)', async () => {
    refreshCalls = 0
    const res = await fetch(`${proxyURL}/api/me`, { headers: { cookie: `${LUKK_SESSION_COOKIE}=garbage-not-a-real-seal` } })
    expect(res.status).toBe(200) // streamed normally, not a 500 from a queued-cookie collision
    expect(refreshCalls).toBe(0) // no session → no refresh
    expect(res.headers.get('set-cookie')).toBeNull() // crucially: no fresh empty session cookie minted
  })

  it('forwards only allow-listed app-API cookies, dropping others and any forged session cookie', async () => {
    const res = await fetch(`${proxyURL}/api/set-cookies`)
    expect(res.status).toBe(200)
    const cookies = res.headers.getSetCookie()
    expect(cookies.some(c => c.startsWith('locale=en'))).toBe(true) // allow-listed → forwarded
    expect(cookies.some(c => c.startsWith('tracking='))).toBe(false) // not listed → stripped
    expect(cookies.some(c => c.startsWith(`${LUKK_SESSION_COOKIE}=`))).toBe(false) // forged session → dropped
  })

  it('streams a binary download back with its headers', async () => {
    const res = await fetch(`${proxyURL}/api/download`)

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/pdf')
    expect(res.headers.get('content-disposition')).toContain('attachment')
    expect(res.headers.get('cache-control')).toBe('private, no-store') // hardened by onResponse
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('%PDF-1.4 binary') // binary intact
  })

  it('forwards an app-defined request header the proxy does not know about', async () => {
    // Documented contract: request headers lukk doesn't explicitly strip or overwrite reach the
    // upstream. Apps depend on this to carry per-visitor data a proxy hop would otherwise destroy
    // (e.g. geo-IP copied off CF-* onto a prefix Cloudflare won't re-stamp). Pinned here so an
    // allowlist refactor can't silently regress it into "wrong country, no error, tests green".
    const res = await fetch(`${proxyURL}/api/me`, { headers: { 'x-visitor-country': 'EE' } })

    expect(res.status).toBe(200)
    expect(received.visitorCountry).toBe('EE')
  })

  it('forwards the socket address, not a client-supplied one, with no trusted header configured', async () => {
    const res = await fetch(`${proxyURL}/api/me`, { headers: { 'x-forwarded-for': '1.2.3.4' } })

    expect(res.status).toBe(200)
    expect(received.xForwardedFor).toBe('127.0.0.1') // the loopback socket, not the forged value
  })

  it('forwards the VISITOR address end-to-end when a trusted clientIpHeader is configured', async () => {
    // The reported defect: behind a reverse proxy the socket address is the proxy, so the upstream
    // sees every visitor as one identity and `throttle:5,1` becomes 5/min globally. Verified the way
    // the report measured it — by echoing the received header from a real upstream.
    const cfg = __test.runtimeConfig.lukk as Record<string, unknown>
    cfg.clientIpHeader = 'cf-connecting-ip'
    try {
      const res = await fetch(`${proxyURL}/api/me`, {
        headers: { 'cf-connecting-ip': '198.51.100.23', 'x-forwarded-for': '1.2.3.4' },
      })

      expect(res.status).toBe(200)
      expect(received.xForwardedFor).toBe('198.51.100.23')
      // The client's own chain never leaks through, in either mode.
      expect(received.xForwardedFor).not.toContain('1.2.3.4')
    }
    finally {
      delete cfg.clientIpHeader
    }
  })
})

// Regression: lukk-nuxt 0.10.0 502'd on every proxied request whose client sent a `Connection`
// header — i.e. every HTTP/1.1 client, and every deployment behind the standard nginx config
// (`proxy_set_header Connection "upgrade"`). The hop-by-hop stripper blanked the names parsed
// out of `Connection`, and undici REFUSES to set `connection`/`keep-alive`/`upgrade`/
// `transfer-encoding` at all — blank or not — so the proxy's own fetch threw before leaving the
// process and h3 turned it into an opaque 502.
//
// Driven with node:http rather than fetch: undici strips `Connection` from outgoing requests, so
// a fetch-based client structurally cannot reproduce this. That is why the unit tests missed it.
function httpGet(path: string, headers: Record<string, string>): Promise<{ status: number, body: string }> {
  return new Promise((resolve, reject) => {
    const { port: p, hostname } = new URL(proxyURL)
    const req = request({ host: hostname, port: Number(p), path, method: 'GET', headers }, (res) => {
      let body = ''
      res.on('data', c => body += c)
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

it('proxies a request from an HTTP/1.1 client that sends Connection: keep-alive', async () => {
  const res = await httpGet('/api/countries', { connection: 'keep-alive' })

  expect(res.status).toBe(200)
  expect(JSON.parse(res.body)).toEqual({ ok: true })
})

it('proxies a request carrying Connection: upgrade (the nginx reverse-proxy config)', async () => {
  // `proxy_set_header Connection "upgrade"` is set unconditionally in Nuxt's own deployment
  // docs, so this arrives on EVERY request, not just websocket upgrades.
  const res = await httpGet('/api/countries', { connection: 'upgrade', upgrade: 'websocket' })

  expect(res.status).toBe(200)
  expect(JSON.parse(res.body)).toEqual({ ok: true })
})

it('still strips a header the client legitimately named in Connection', async () => {
  // The feature this stripper exists for (RFC 9110 §7.6.1) must keep working — the fix skips only
  // the names fetch manages itself, not custom single-hop headers.
  //
  // Neutralised by BLANKING, not by removal: `proxyRequest` merges over the inbound headers, so
  // omitting a key leaves the client's value in place. The upstream therefore sees the header
  // present-but-empty rather than absent. Strictly §7.6.1 says "remove", and this is as close as
  // that API allows — what matters is that the client's value does not survive the hop.
  const res = await httpGet('/api/echo', {
    'connection': 'keep-alive, x-visitor-country',
    'x-visitor-country': 'SE',
  })

  expect(res.status).toBe(200)
  expect(received.visitorCountry).toBe('')
  expect(received.visitorCountry).not.toBe('SE')
})

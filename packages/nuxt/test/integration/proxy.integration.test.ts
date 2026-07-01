import type { Server } from 'node:http'
import { createServer } from 'node:http'
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
let received: { method?: string, contentType?: string, accept?: string, authorization?: string, body: Buffer } = { body: Buffer.alloc(0) }
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
      received = { method: req.method, contentType: req.headers['content-type'], accept: req.headers.accept, authorization: req.headers.authorization, body: Buffer.concat(chunks) }
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

  it('streams a binary download back with its headers', async () => {
    const res = await fetch(`${proxyURL}/api/download`)

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/pdf')
    expect(res.headers.get('content-disposition')).toContain('attachment')
    expect(res.headers.get('cache-control')).toBe('private, no-store') // hardened by onResponse
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('%PDF-1.4 binary') // binary intact
  })
})

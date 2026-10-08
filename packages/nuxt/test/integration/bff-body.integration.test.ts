import type { Server } from 'node:http'
import { createServer, request } from 'node:http'
import { createApp, toNodeListener } from 'h3'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
// REAL h3 + the real auth proxy over real sockets: the body reader and the response labelling depend on
// h3's own stream and content-type behaviour, which the unit suite can only imitate.
import { __test } from '../mocks/imports'
import handler from '../../src/runtime/server/bff'

let lukk: Server
let proxy: Server
let proxyPort = 0
let received: { url?: string, body?: string } = {}

const port = (s: Server) => (s.address() as { port: number }).port

beforeAll(async () => {
  lukk = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c as Buffer))
    req.on('end', () => {
      received = { url: req.url, body: Buffer.concat(chunks).toString() }
      if (req.url?.endsWith('/html')) {
        res.setHeader('content-type', 'text/html')
        res.end('<script>alert(1)</script>')
        return
      }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ echoed: received.body.length }))
    })
  })
  await new Promise<void>(r => lukk.listen(0, '127.0.0.1', r))
  __test.runtimeConfig.lukk = { baseURL: `http://127.0.0.1:${port(lukk)}/auth`, sessionPassword: 'p'.repeat(32), cookieSecure: false, bodyLimit: 1024 } as unknown as Record<string, unknown>

  const app = createApp()
  app.use(handler)
  proxy = createServer(toNodeListener(app))
  await new Promise<void>(r => proxy.listen(0, '127.0.0.1', r))
  proxyPort = port(proxy)
})

afterAll(() => { lukk?.close(); proxy?.close() })

/** node:http, so the test controls Content-Length and chunking (fetch would set them itself). */
function send(method: string, path: string, chunks: string[], headers: Record<string, string> = {}): Promise<{ status: number, type?: string, sniff?: string, body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: proxyPort, path, method, headers: { host: `127.0.0.1:${proxyPort}`, ...headers } }, (res) => {
      const out: Buffer[] = []
      res.on('data', c => out.push(c as Buffer))
      res.on('end', () => resolve({ status: res.statusCode!, type: res.headers['content-type'], sniff: res.headers['x-content-type-options'] as string | undefined, body: Buffer.concat(out).toString() }))
    })
    // A server answering 413 early may close before the rest is written.
    req.on('error', (error: NodeJS.ErrnoException) => (error.code === 'ECONNRESET' || error.code === 'EPIPE' ? undefined : reject(error)))
    for (const chunk of chunks) req.write(chunk)
    req.end()
  })
}

describe('auth proxy over real h3', () => {
  it('forwards a body within the limit intact', async () => {
    const body = JSON.stringify({ email: 'é@example.com', pad: 'x'.repeat(900) })
    expect((await send('POST', '/api/_lukk/login', [body], { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) })).status).toBe(200)
    expect(received.body).toBe(body)
  })

  it('answers 413 to a declared length over the limit, and 411 to a chunked body — lukk never called', async () => {
    received = {}
    const declared = await send('POST', '/api/_lukk/login', ['x'.repeat(2048)], { 'content-length': '2048' })
    expect(declared.status).toBe(413)
    // node:http sends a body written without a Content-Length chunked.
    const chunked = await send('POST', '/api/_lukk/register', ['x'.repeat(600), 'x'.repeat(600)])
    expect(chunked.status).toBe(411)
    const small = await send('POST', '/api/_lukk/register', ['{}'])
    expect(small.status).toBe(411)
    expect(received).toEqual({})
  })

  it('does not let a body run past its declared length — Node ends it there', async () => {
    // What makes the declared length a sound bound: the parser reads exactly that many bytes.
    // The excess is parsed as a (malformed) next request, which Node answers 400 and closes on.
    received = {}
    await send('POST', '/api/_lukk/login', ['{}', 'x'.repeat(4096)], { 'content-length': '2' })
    expect(received.body ?? '').not.toContain('x')
  })

  it('reads no body for a bodiless DELETE', async () => {
    expect((await send('DELETE', '/api/_lukk/sessions/1', [])).status).toBe(200)
    expect(received.body).toBe('')
  })

  it('labels a non-JSON upstream body as text, and forbids sniffing', async () => {
    const res = await send('GET', '/api/_lukk/html', [])
    expect(res.body).toBe('<script>alert(1)</script>')
    expect(res.type).toBe('text/plain; charset=utf-8')
    expect(res.sniff).toBe('nosniff')
  })

  it('labels a JSON body as JSON', async () => {
    const res = await send('GET', '/api/_lukk/x', [])
    expect(res.type).toBe('application/json; charset=utf-8')
    expect(JSON.parse(res.body)).toEqual({ echoed: 0 })
  })
})

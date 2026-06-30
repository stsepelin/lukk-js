import type { Server } from 'node:http'
import { createServer } from 'node:http'
import { createApp, toNodeListener } from 'h3'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
// REAL h3 (no vi.mock here) + the real proxy handler, driven over real sockets
// against a throwaway upstream — so multipart upload + binary download transit is
// genuinely exercised, not just the handler's header config.
import { __test } from '../mocks/imports'
import handler from '../../src/runtime/server/api-proxy'

let upstream: Server
let proxy: Server
let proxyURL = ''
let received: { method?: string, contentType?: string, accept?: string, body: Buffer } = { body: Buffer.alloc(0) }

const port = (s: Server) => (s.address() as { port: number }).port

beforeAll(async () => {
  // Upstream "Laravel": echoes the upload; serves a binary for /download.
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
      received = { method: req.method, contentType: req.headers['content-type'], accept: req.headers.accept, body: Buffer.concat(chunks) }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ok: true }))
    })
  })
  await new Promise<void>(r => upstream.listen(0, '127.0.0.1', r))

  __test.runtimeConfig.lukk = {
    apiPath: '/api',
    apiTarget: `http://127.0.0.1:${port(upstream)}`,
    apiForceJson: true,
    sessionPassword: 'p'.repeat(32),
  } as unknown as Record<string, unknown>

  const app = createApp()
  app.use(handler)
  proxy = createServer(toNodeListener(app))
  await new Promise<void>(r => proxy.listen(0, '127.0.0.1', r))
  proxyURL = `http://127.0.0.1:${port(proxy)}`
})

afterAll(() => { upstream?.close(); proxy?.close() })

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

  it('streams a binary download back with its headers', async () => {
    const res = await fetch(`${proxyURL}/api/download`)

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/pdf')
    expect(res.headers.get('content-disposition')).toContain('attachment')
    expect(res.headers.get('cache-control')).toBe('private, no-store') // hardened by onResponse
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('%PDF-1.4 binary') // binary intact
  })
})

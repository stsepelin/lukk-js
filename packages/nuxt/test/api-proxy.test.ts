import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __test } from './mocks/imports'

const proxyRequest = vi.fn(async (event: { node: { res: { removeHeader: unknown, setHeader: unknown } } }, target: string, opts?: { headers?: Record<string, string>, onResponse?: (e: unknown, r: unknown) => void }) => {
  // h3 calls onResponse after setting upstream headers, before streaming the body.
  if (opts?.onResponse) await opts.onResponse(event, { headers: new Headers() })
  return { target, headers: opts?.headers }
})
vi.mock('h3', () => ({
  defineEventHandler: (fn: unknown) => fn,
  getRequestHeader: (event: { headers?: Record<string, string> }, name: string) => event.headers?.[name],
  getRequestIP: (event: { ip?: string }) => event.ip,
  setResponseStatus: (event: { status: number }, status: number) => { event.status = status },
  proxyRequest: (...args: unknown[]) => (proxyRequest as (...a: unknown[]) => unknown)(...args),
}))

// eslint-disable-next-line import/first
import { getLukkAccessToken } from '../src/runtime/server/utils/session'

vi.mock('../src/runtime/server/utils/session', () => ({ getLukkAccessToken: vi.fn() }))

// eslint-disable-next-line import/first
import handler from '../src/runtime/server/api-proxy'

const getAccess = vi.mocked(getLukkAccessToken)

function ev(o: { path: string, method?: string, headers?: Record<string, string> }) {
  return {
    path: o.path,
    method: o.method ?? 'GET',
    headers: o.headers ?? {},
    status: 200,
    ip: '203.0.113.7' as string | undefined,
    node: { res: { removeHeader: vi.fn(), setHeader: vi.fn() } },
  }
}
const run = (e: ReturnType<typeof ev>) => (handler as unknown as (e: unknown) => Promise<unknown>)(e)
const sameOrigin = { origin: 'https://app.test', host: 'app.test' }

beforeEach(() => { __test.runtimeConfig.lukk = { apiPath: '/api', apiTarget: 'https://laravel.test', apiForceJson: true } as unknown as Record<string, unknown> })
afterEach(() => { __test.reset(); vi.clearAllMocks() })

describe('app-API proxy', () => {
  it('injects the bearer, strips the cookie/authorization + spoofable forwarding headers, sets a trusted XFF', async () => {
    getAccess.mockResolvedValue('tok')
    await run(ev({ path: '/api/users?page=2', headers: { 'cookie': 'lukk-session=sealed', 'authorization': 'Bearer forged', 'x-forwarded-for': '9.9.9.9' } }))
    expect(proxyRequest).toHaveBeenCalledWith(
      expect.anything(),
      'https://laravel.test/users?page=2',
      expect.objectContaining({
        streamRequest: true,
        headers: expect.objectContaining({
          'accept': 'application/json', // force JSON so Laravel renders clean 401/422
          'cookie': '',
          'authorization': 'Bearer tok',
          'x-forwarded-for': '203.0.113.7', // trusted connection IP, not the spoofed 9.9.9.9
          'x-forwarded-host': '',
          'forwarded': '',
          'x-real-ip': '',
        }),
      }),
    )
  })

  it('forwards the browser Accept when forceJson is disabled', async () => {
    __test.runtimeConfig.lukk = { apiPath: '/api', apiTarget: 'https://laravel.test', apiForceJson: false } as unknown as Record<string, unknown>
    getAccess.mockResolvedValue('tok')
    await run(ev({ path: '/api/report.pdf', headers: { accept: 'application/pdf' } }))
    expect(proxyRequest).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ headers: expect.objectContaining({ accept: 'application/pdf' }) }))
  })

  it('sends an empty Accept when forceJson is off and the browser sent none', async () => {
    __test.runtimeConfig.lukk = { apiPath: '/api', apiTarget: 'https://laravel.test', apiForceJson: false } as unknown as Record<string, unknown>
    getAccess.mockResolvedValue('tok')
    await run(ev({ path: '/api/x' }))
    expect(proxyRequest).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ headers: expect.objectContaining({ accept: '' }) }))
  })

  it('streams uploads without clobbering the multipart Content-Type', async () => {
    getAccess.mockResolvedValue('tok')
    await run(ev({ path: '/api/upload', method: 'POST', headers: { ...sameOrigin, 'content-type': 'multipart/form-data; boundary=xyz' } }))
    const opts = (proxyRequest.mock.calls[0] as unknown[])[2] as { streamRequest?: boolean, headers?: Record<string, string> }
    expect(opts.streamRequest).toBe(true) // body streamed, not buffered
    expect(opts.headers).not.toHaveProperty('content-type') // forwarded by h3, not overridden
  })

  it('strips upstream Set-Cookie and marks the response non-cacheable', async () => {
    getAccess.mockResolvedValue('tok')
    const e = ev({ path: '/api/me' })
    await run(e)
    expect(e.node.res.removeHeader).toHaveBeenCalledWith('set-cookie')
    expect(e.node.res.setHeader).toHaveBeenCalledWith('cache-control', 'private, no-store')
  })

  it('sets an empty XFF when the connection IP is unknown', async () => {
    getAccess.mockResolvedValue('tok')
    const e = ev({ path: '/api/x' })
    e.ip = undefined
    await run(e)
    expect(proxyRequest).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ headers: expect.objectContaining({ 'x-forwarded-for': '' }) }))
  })

  it('forwards without a bearer when unauthenticated (still strips the cookie)', async () => {
    getAccess.mockResolvedValue(null)
    await run(ev({ path: '/api/me' }))
    expect(proxyRequest).toHaveBeenCalledWith(
      expect.anything(),
      'https://laravel.test/me',
      expect.objectContaining({ headers: expect.objectContaining({ cookie: '', authorization: '' }) }),
    )
  })

  it('splits the query on the first ? only', async () => {
    getAccess.mockResolvedValue('tok')
    await run(ev({ path: '/api/search?q=a?b=c' }))
    expect(proxyRequest).toHaveBeenCalledWith(expect.anything(), 'https://laravel.test/search?q=a?b=c', expect.anything())
  })

  it('allows a same-origin POST', async () => {
    getAccess.mockResolvedValue('tok')
    await run(ev({ path: '/api/orders', method: 'POST', headers: sameOrigin }))
    expect(proxyRequest).toHaveBeenCalledOnce()
  })

  it('allows a non-GET request that carries no Origin (non-browser client)', async () => {
    getAccess.mockResolvedValue('tok')
    await run(ev({ path: '/api/orders', method: 'POST' }))
    expect(proxyRequest).toHaveBeenCalledOnce()
  })

  it('proxies the mount root', async () => {
    getAccess.mockResolvedValue('tok')
    await run(ev({ path: '/api' }))
    expect(proxyRequest).toHaveBeenCalledWith(expect.anything(), 'https://laravel.test/', expect.anything())
  })

  it('rejects a cross-origin state-changing request (CSRF)', async () => {
    const e = ev({ path: '/api/orders', method: 'POST', headers: { origin: 'https://evil.com', host: 'app.test' } })
    await run(e)
    expect(e.status).toBe(403)
    expect(proxyRequest).not.toHaveBeenCalled()
  })

  it('refuses to proxy the lukk BFF routes', async () => {
    const e = ev({ path: '/api/_lukk/login', method: 'POST', headers: sameOrigin })
    await run(e)
    expect(e.status).toBe(404)
    expect(proxyRequest).not.toHaveBeenCalled()
  })

  it('rejects a path outside the mount', async () => {
    const e = ev({ path: '/apixyz' })
    await run(e)
    expect(e.status).toBe(404)
    expect(proxyRequest).not.toHaveBeenCalled()
  })

  it('rejects a path that escapes the fixed target (SSRF / traversal)', async () => {
    __test.runtimeConfig.lukk = { apiPath: '/api', apiTarget: 'https://laravel.test/v1' } as unknown as Record<string, unknown>
    const e = ev({ path: '/api/../../etc/passwd' })
    await run(e)
    expect(e.status).toBe(400)
    expect(proxyRequest).not.toHaveBeenCalled()
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('h3', () => ({
  getRequestHeader: (event: { headers?: Record<string, string> }, name: string) => event.headers?.[name],
  setResponseStatus: (event: { status?: number }, status: number) => { event.status = status },
}))

// eslint-disable-next-line import/first
import { rejectUnresolvedTarget, resolveTarget } from '../src/runtime/server/proxy-utils'

const ev = () => ({ status: 200 } as { status: number })

afterEach(() => vi.restoreAllMocks())

describe('resolveTarget', () => {
  it('resolves a subpath under the base', () => {
    expect(resolveTarget('https://api.example.com/auth', '/login')).toBe('https://api.example.com/auth/login')
  })

  it('returns null for an unusable base (the config fault)', () => {
    expect(resolveTarget('undefined/auth', '/forgot-password')).toBeNull()
    expect(resolveTarget('', '/login')).toBeNull()
    // Parses as scheme `localhost:` with a null origin — containment would be meaningless.
    expect(resolveTarget('localhost:3000/auth', '/login')).toBeNull()
  })

  it('returns null for a subpath that escapes the base (the traversal fault)', () => {
    expect(resolveTarget('https://api.example.com/auth', '../admin')).toBeNull()
    expect(resolveTarget('https://api.example.com/auth', '%2e%2e/admin')).toBeNull()
  })

  it('resolves from the PARSED base, so surrounding whitespace is not a fake traversal', () => {
    // A stray space from a .env/YAML copy-paste survives the build gate (the URL parser trims it)
    // but used to slice into the raw target as `/auth%20/login` → containment fails → every single
    // request 400s and is logged as a traversal attempt. That's the misdiagnosis this file exists
    // to prevent, so the base must be canonicalised before use.
    expect(resolveTarget(' https://api.example.com/auth ', '/login')).toBe('https://api.example.com/auth/login')
  })

  it('ignores a query/fragment on the base instead of swallowing the subpath into it', () => {
    // `/auth?t=1` + `/login` naively resolves to `/auth?t=1/login`, which PASSES containment while
    // sending every route to the same upstream endpoint. The module rejects such a base at build;
    // a runtime override must still resolve the real path.
    expect(resolveTarget('https://api.example.com/auth?tenant=1', '/login')).toBe('https://api.example.com/auth/login')
    expect(resolveTarget('https://api.example.com/auth#frag', '/login')).toBe('https://api.example.com/auth/login')
  })

  it('keeps containment for a sibling path that merely shares a prefix', () => {
    expect(resolveTarget('https://api.example.com/auth', '../auth2/x')).toBeNull()
  })
})

describe('rejectUnresolvedTarget', () => {
  it('names a misconfigured base — 5xx, and logs the offending value server-side', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const event = ev()

    const body = rejectUnresolvedTarget(event, 'undefined/auth', '`baseURL`', '/forgot-password')

    // A server misconfiguration, not a bad request: 4xx would keep 5xx alerting silent through a
    // total auth outage and let CDNs file it as client noise.
    expect(event.status).toBe(500)
    // The regression this guards: a bad baseURL used to answer "Invalid path.", sending operators
    // hunting a route mismatch. The body now points at config — without echoing the value.
    expect(body.message).toContain('Proxy target could not be resolved')
    expect(body.message).not.toContain('undefined/auth')
    expect(error).toHaveBeenCalledOnce()
    expect(String(error.mock.calls[0]![0])).toContain('undefined/auth')
  })

  it('logs a broken base once per value, not once per request', () => {
    // Fixed server config → the message never changes, so an unauthenticated caller must not be
    // able to drive unbounded log volume against a misconfigured deploy.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const base = `undefined/auth-${Math.random()}` // unreported base, independent of test order

    for (let i = 0; i < 5; i++) expect(rejectUnresolvedTarget(ev(), base, '`baseURL`', '/x').message).toContain('could not be resolved')

    expect(error).toHaveBeenCalledOnce()
  })

  it('still reports a genuine path escape as an invalid path', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const event = ev()

    const body = rejectUnresolvedTarget(event, 'https://api.example.com/auth', '`baseURL`', '../admin')

    expect(event.status).toBe(400)
    expect(body).toEqual({ message: 'Invalid path.' })
    expect(warn).toHaveBeenCalledOnce()
    expect(String(warn.mock.calls[0]![0])).toContain('../admin')
  })

  // Last in the file on purpose: the escape-log budget is module-level, so exhausting it here
  // would silence the assertions above if this ran earlier.
  it('caps escape-rejection logging, which an unauthenticated caller can drive', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    for (let i = 0; i < 80; i++) rejectUnresolvedTarget(ev(), 'https://api.example.com/auth', '`baseURL`', `../${i}`)

    // Every request is still rejected; only the log line is bounded per process.
    expect(warn.mock.calls.length).toBeLessThanOrEqual(50)
    expect(String(warn.mock.calls.at(-1)?.[0])).toContain('further path rejections will not be logged')
  })
})

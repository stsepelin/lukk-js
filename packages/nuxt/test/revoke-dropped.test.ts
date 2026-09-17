import type { H3Event } from 'h3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { revokeDroppedSession } from '../src/runtime/server/revoke-dropped'

afterEach(() => vi.restoreAllMocks())

const event = (waitUntil?: (p: Promise<unknown>) => void) => ({ waitUntil }) as unknown as H3Event

describe('revokeDroppedSession', () => {
  it('logs the dropped session out with the access token its rotation just minted', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }))
    const waitUntil = vi.fn()

    revokeDroppedSession(event(waitUntil), 'A2', 'https://lukk.test/auth', '198.51.100.7')

    expect(fetchSpy).toHaveBeenCalledWith('https://lukk.test/auth/logout', {
      method: 'POST',
      headers: { 'Accept': 'application/json', 'Authorization': 'Bearer A2', 'X-Forwarded-For': '198.51.100.7' },
      redirect: 'manual',
    })
    // Kept alive past the response on runtimes that end the invocation with it.
    expect(waitUntil).toHaveBeenCalledWith(expect.any(Promise))
    await expect(waitUntil.mock.calls[0]![0]).resolves.toBeUndefined()
  })

  it('names no visitor when it has none, and runs without waitUntil', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }))

    revokeDroppedSession(event(), 'A2', 'https://lukk.test/auth')

    expect((fetchSpy.mock.calls[0]![1] as { headers: Record<string, string> }).headers).not.toHaveProperty('X-Forwarded-For')
  })

  it('swallows a failure — best effort, never an unhandled rejection', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'))
    const waitUntil = vi.fn()

    revokeDroppedSession(event(waitUntil), 'A2', 'https://lukk.test/auth')

    await expect(waitUntil.mock.calls[0]![0]).resolves.toBeUndefined()
  })

  it('sends nothing without a token to revoke with, or to an unusable base', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    vi.spyOn(console, 'error').mockImplementation(() => {})

    revokeDroppedSession(event(), undefined, 'https://lukk.test/auth')
    revokeDroppedSession(event(), 'A2', 'undefined/auth')

    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

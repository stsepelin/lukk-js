import { describe, expect, it } from 'vitest'
import { LUKK_SSR_HEADER } from '../src/runtime/shared'
import marker from '../src/runtime/plugins/render-marker.server'

describe('the render marker', () => {
  it('marks the page request itself, so every in-render $fetch to the app-API proxy carries it', () => {
    // Nuxt's useFetch, useRequestFetch() and event.$fetch copy the page request's headers — the session
    // cookie included — into their in-process requests. Unmarked, the app-API proxy rotated for them, and
    // the rotated cookie went back to the render instead of the page: the browser replayed T0 and was revoked.
    const event = { node: { req: { headers: { cookie: 'c' } as Record<string, string> } } }
    ;(marker as unknown as (app: unknown) => void)({ ssrContext: { event } })

    expect(event.node.req.headers[LUKK_SSR_HEADER]).toBe('1')
    expect((marker as unknown as { meta: unknown }).meta).toEqual({ name: 'lukk:render-marker', enforce: 'pre' })
  })

  it('does nothing outside a render', () => {
    expect(() => (marker as unknown as (app: unknown) => void)({})).not.toThrow()
  })
})

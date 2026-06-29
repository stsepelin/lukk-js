import { describe, expect, it, vi } from 'vitest'
import { createLukkClient } from '../src/client'
import * as publicApi from '../src/index'

describe('public API barrel', () => {
  it('re-exports the public surface', () => {
    expect(publicApi.createLukkClient).toBeTypeOf('function')
    expect(publicApi.isTokenPair).toBeTypeOf('function')
    expect(publicApi.isTwoFactorChallenge).toBeTypeOf('function')
    expect(publicApi.bufferToBase64url).toBeTypeOf('function')
    expect(publicApi.singleFlight).toBeTypeOf('function')
  })
})

describe('default fetch', () => {
  it('uses globalThis.fetch when no fetch hook is given', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ remaining: 1, total: 8 }), { status: 200, headers: { 'content-type': 'application/json' } }),
    )
    await createLukkClient({ baseURL: 'https://x/auth' }).recoveryCodeCount()
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })
})

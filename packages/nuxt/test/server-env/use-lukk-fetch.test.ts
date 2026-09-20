import { beforeEach, describe, expect, it, vi } from 'vitest'
import { __test } from '../mocks/imports'
import { createLukkFetch, createRequestFetch } from '../../src/runtime/utils/create-lukk-fetch'
import { useLukkFetch } from '../../src/runtime/composables/useLukkFetch'

vi.mock('../../src/runtime/utils/create-lukk-fetch', () => ({ createLukkFetch: vi.fn(() => 'DIRECT'), createRequestFetch: vi.fn(() => 'REQUEST') }))

beforeEach(() => { __test.reset(); vi.clearAllMocks() })

describe('useLukkFetch on the server', () => {
  it('routes BFF calls through the request-aware fetch, which resolves the proxy mount in-process', () => {
    __test.runtimeConfig.public.lukk = { mode: 'bff', apiBaseURL: '/api' }

    expect(useLukkFetch()).toBe('REQUEST')
    expect(createLukkFetch).not.toHaveBeenCalled()
    expect(vi.mocked(createRequestFetch).mock.calls[0]![1]).toMatchObject({ isServer: true, canRefresh: false })
  })

  it('knows it is on the server in direct mode, and never refreshes there — the token lives in the browser', () => {
    __test.runtimeConfig.public.lukk = { mode: 'direct', apiBaseURL: 'https://api.example.com' }

    expect(useLukkFetch()).toBe('DIRECT')
    expect(vi.mocked(createLukkFetch).mock.calls[0]![0]).toMatchObject({ isServer: true, canRefresh: false })
  })
})

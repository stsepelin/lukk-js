import { afterEach, describe, expect, it, vi } from 'vitest'
import { warnIfSessionTooLarge } from '../src/runtime/server/session-size'

afterEach(() => vi.restoreAllMocks())

/** A session whose JSON is exactly `length` characters. */
const sessionOf = (length: number) => ({ data: { access: 'x'.repeat(length - '{"access":""}'.length) } })

describe('warnIfSessionTooLarge', () => {
  it('stays quiet up to the budget and warns past it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    warnIfSessionTooLarge(sessionOf(2600))
    expect(warn).not.toHaveBeenCalled()

    warnIfSessionTooLarge(sessionOf(2601))
    expect(warn).toHaveBeenCalledOnce()
  })

  it('says what breaks and what to trim', () => {
    // The failure it warns about is silent — every request just turns anonymous — so the message is the
    // only place the cause and the fix are ever named.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    warnIfSessionTooLarge(sessionOf(4000))

    const message = String(warn.mock.calls[0]![0])
    expect(message).toContain('RFC 6265bis §5.6')
    expect(message).toContain('every request becomes anonymous')
    expect(message).toContain('Lukk::tokenClaimsUsing')
  })
})

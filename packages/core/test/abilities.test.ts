import { describe, expect, it } from 'vitest'
import { can, canAll, canAny, cannot, enforcesAbilities, LUKK_ACCOUNT, LUKK_ACCOUNT_DELETE, LUKK_SESSIONS, normalize } from '../src/abilities'

describe('can', () => {
  it('matches an ability exactly', () => {
    expect(can(['orders.read'], 'orders.read')).toBe(true)
    expect(can(['orders.read'], 'orders.write')).toBe(false)
  })

  it('treats * as everything', () => {
    expect(can(['*'], 'anything.at.all')).toBe(true)
  })

  it('expands a prefix wildcard but not the bare namespace', () => {
    // `orders.*` is about what lives UNDER the namespace. Including the namespace itself would make
    // `orders.*` and `orders` indistinguishable to anyone reading a policy.
    expect(can(['orders.*'], 'orders.read')).toBe(true)
    expect(can(['orders.*'], 'orders.read.all')).toBe(true)
    expect(can(['orders.*'], 'orders')).toBe(false)
    expect(can(['orders.*'], 'ordersX.read')).toBe(false)
  })

  it('never honours a wildcard in the CHECK', () => {
    // Otherwise a caller widens their own question: `can(user, 'orders.*')` would pass on a token
    // granted only `orders.read`, and any UI written that way would show what the server refuses.
    expect(can(['orders.read'], 'orders.*')).toBe(false)
    expect(can(['orders.read'], '*')).toBe(false)
    // ...but asking for the literal ability that WAS granted still works.
    expect(can(['orders.*'], 'orders.*')).toBe(true)
  })

  it('only widens from a grant that ends in `.*`', () => {
    // The prefix rule is the wildcard's alone. If any grant were treated as a prefix, holding
    // `orders.read` would satisfy `orders.readable` — and, worse, `orders` would satisfy everything
    // in the namespace the bare ability was deliberately kept out of.
    expect(can(['orders.read'], 'orders.readable')).toBe(false)
    expect(can(['orders'], 'orders.read')).toBe(false)
  })

  it('compares case-sensitively', () => {
    // Scope tokens are opaque strings (RFC 6749 §3.3). Folding case would satisfy a gate with an
    // ability nobody granted under that name.
    expect(can(['orders.read'], 'ORDERS.READ')).toBe(false)
    expect(can(['Billing.*'], 'Billing.view')).toBe(true)
    expect(can(['Billing.*'], 'billing.view')).toBe(false)
  })

  it('grants nothing for an empty list, and everything when abilities are absent', () => {
    // The distinction the whole feature rests on: `[]` is "in use, granted nothing" — hide the UI;
    // absent is "this server doesn't use abilities" — show it, or every app that upgraded without
    // opting in finds its UI blank.
    expect(can([], 'orders.read')).toBe(false)
    expect(can(undefined, 'orders.read')).toBe(true)
    expect(can(null, 'orders.read')).toBe(true)
  })

  it('refuses an empty ability name even against a wildcard grant', () => {
    expect(can(['*'], '')).toBe(false)
  })
})

describe('cannot', () => {
  it('is the exact inverse of can', () => {
    expect(cannot(['orders.read'], 'orders.write')).toBe(true)
    expect(cannot(['orders.read'], 'orders.read')).toBe(false)
    expect(cannot(undefined, 'orders.read')).toBe(false)
  })
})

describe('canAny / canAll', () => {
  it('distinguishes any-of from all-of', () => {
    const granted = ['orders.read']
    expect(canAny(granted, ['orders.read', 'orders.write'])).toBe(true)
    expect(canAll(granted, ['orders.read', 'orders.write'])).toBe(false)
    expect(canAll(granted, ['orders.read'])).toBe(true)
  })

  it('never satisfies an empty requirement', () => {
    // Mirrors the server, where `lukk.abilities:` with no arguments is a route bug rather than a
    // free pass. A UI that showed everything for `canAll(user, [])` would disagree with it.
    expect(canAny(['*'], [])).toBe(false)
    expect(canAll(['*'], [])).toBe(false)
  })

  it('carries the absent-means-permitted rule through both', () => {
    expect(canAny(undefined, ['orders.read'])).toBe(true)
    expect(canAll(undefined, ['orders.read', 'orders.write'])).toBe(true)
  })
})

describe('a malformed abilities value from the network', () => {
  // `abilities?: string[]` is a compile-time claim about a JSON body the APP's user endpoint
  // produces. These all used to throw a TypeError — and `v-if="can('x')"` throwing takes the whole
  // component render down, so a one-line mistake in a user resource blanked the page.
  const MALFORMED = [
    ['a bare string (a single-role app)', 'admin'],
    ['an object', {}],
    ['numbers', [1, 2]],
    ['nested arrays', [['a']]],
    ['a boolean', true],
    ['a number', 7],
  ] as const

  it.each(MALFORMED)('grants nothing rather than throwing for %s', (_label, value) => {
    expect(() => can(value, 'orders.read')).not.toThrow()
    // Fails CLOSED: the server is clearly sending something, we just can't read it. Mirrors the
    // server, where `Abilities::fromScope()` maps a non-string claim to an empty grant.
    expect(can(value, 'orders.read')).toBe(false)
    expect(canAny(value, ['orders.read'])).toBe(false)
    expect(canAll(value, ['orders.read'])).toBe(false)
    expect(enforcesAbilities(value)).toBe(true)
    // And the grant it reports is genuinely EMPTY, not a salvage attempt: `normalize` is exported,
    // so a caller rendering the list must not be shown an ability nobody was granted.
    expect(normalize(value)).toEqual([])
  })

  it('drops a non-string entry but honours its valid siblings', () => {
    expect(can([null, 'orders.read', 3], 'orders.read')).toBe(true)
    expect(can([null, 'orders.read', 3], 'orders.write')).toBe(false)
  })

  it('still treats a genuinely absent value as "abilities not in use"', () => {
    // The one shape that must NOT fail closed, or every app that upgrades without opting in finds
    // its UI blank.
    expect(enforcesAbilities(undefined)).toBe(false)
    expect(enforcesAbilities(null)).toBe(false)
    expect(enforcesAbilities([])).toBe(true)
  })
})

describe('a non-string ability', () => {
  it('never throws, even against a wildcard grant', () => {
    // `ability.startsWith` is reached only inside the `grant.endsWith('.*')` branch, so this threw
    // ONLY for users holding a wildcard grant: a developer with a narrow grant saw `false` and
    // shipped, and the admin got a blank component. `v-for="p in permissionsFromApi"` with
    // `v-if="can(p)"` is all it takes.
    for (const ability of [5, { x: 1 }, ['orders.read'], null, undefined, true] as unknown[]) {
      expect(() => can(['orders.*'], ability as string)).not.toThrow()
      expect(can(['orders.*'], ability as string)).toBe(false)
      expect(can(['orders.read'], ability as string)).toBe(false)
    }
  })
})

describe('normalize drops what the server would have refused at mint', () => {
  it('rejects a comma, so the client rule is a subset of the server gate', () => {
    // The route gate splits `lukk.ability:a,b` on commas, so a grant containing one matches here and
    // is refused there. Unreachable while `abilities` comes from lukk's UserResource; reachable the
    // moment an app publishes the field from its own source, which the `string[]` type invites.
    expect(normalize(['orders,read', 'orders.read'])).toEqual(['orders.read'])
    expect(can(['orders,read'], 'orders,read')).toBe(false)
  })

  it('rejects an empty entry, which is not a scope token at all', () => {
    // RFC 6749 §3.3 scope tokens are non-empty, so `''` only ever arrives as a serialisation
    // artefact (a stray `explode(' ', '')` upstream). Keeping it would have `normalize` report a
    // grant of one ability where the server has none.
    expect(normalize(['', 'orders.read'])).toEqual(['orders.read'])
    expect(normalize([''])).toEqual([])
  })

  it('rejects whitespace and an oversized ability', () => {
    expect(normalize(['orders read'])).toEqual([])
    expect(normalize(['a'.repeat(129)])).toEqual([])
    expect(normalize(['a'.repeat(128)])).toEqual(['a'.repeat(128)])
  })
})

describe('lukk\'s own abilities', () => {
  it('are exported so a client never has to hardcode the strings', () => {
    expect(LUKK_SESSIONS).toBe('lukk.sessions')
    expect(LUKK_ACCOUNT).toBe('lukk.account')
    expect(LUKK_ACCOUNT_DELETE).toBe('lukk.account.delete')
  })

  it('does not let `lukk.account` imply erasing the account', () => {
    // Only a `.*` grant widens, so an exact `lukk.account` misses `lukk.account.delete` — mirroring
    // the server, where folding the destructive ability into the older one would have handed every
    // token already carrying it the power to destroy the account.
    expect(can([LUKK_ACCOUNT], LUKK_ACCOUNT_DELETE)).toBe(false)
    expect(can(['lukk.account.*'], LUKK_ACCOUNT_DELETE)).toBe(true)
  })
})

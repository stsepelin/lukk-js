import { ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { __test } from './mocks/imports'

const user = ref<unknown>(null)
vi.mock('../src/runtime/composables/useLukkAuth', () => ({ useLukkAuth: () => ({ user }) }))

// eslint-disable-next-line import/first
import { useLukkAbilities } from '../src/runtime/composables/useLukkAbilities'

afterEach(() => { __test.reset(); user.value = null })

describe('useLukkAbilities', () => {
  it('reads the granted list off the loaded user and tracks it reactively', () => {
    // Reactive because the list changes on login, on logout, and on any refresh that re-derives it
    // — a snapshot taken at setup would leave the UI showing the previous session's permissions.
    const a = useLukkAbilities()

    expect(a.abilities.value).toBeUndefined()
    user.value = { id: 1, abilities: ['orders.read', 'billing.*'] }
    expect(a.abilities.value).toEqual(['orders.read', 'billing.*'])
    expect(a.can('orders.read')).toBe(true)
    expect(a.can('billing.view')).toBe(true)
    expect(a.cannot('orders.write')).toBe(true)
  })

  it('distinguishes "granted nothing" from "this server does not use abilities"', () => {
    // `enforced` is the only way to tell them apart, and the difference decides whether hiding UI on
    // `cannot()` hides everything or nothing.
    const a = useLukkAbilities()

    user.value = { id: 1 }
    expect(a.enforced.value).toBe(false)
    expect(a.can('orders.read')).toBe(true)

    user.value = { id: 1, abilities: [] }
    expect(a.enforced.value).toBe(true)
    expect(a.can('orders.read')).toBe(false)
  })

  it('mirrors the two server gates', () => {
    user.value = { id: 1, abilities: ['orders.read'] }
    const a = useLukkAbilities()

    expect(a.canAny(['orders.read', 'orders.write'])).toBe(true) // lukk.ability:a,b
    expect(a.canAll(['orders.read', 'orders.write'])).toBe(false) // lukk.abilities:a,b
    expect(a.canAll(['orders.read'])).toBe(true)
  })

  it('grants nothing when logged out', () => {
    // A null user is NOT "a server without abilities". Falling through to the absent-list rule
    // rendered every privileged control before anyone signed in — and what renders is the
    // entitlement taxonomy itself, menu items named after the abilities.
    const a = useLukkAbilities()

    user.value = null
    expect(a.can('orders.read')).toBe(false)
    expect(a.cannot('orders.read')).toBe(true)
    expect(a.canAny(['orders.read'])).toBe(false)
    expect(a.canAll(['orders.read'])).toBe(false)
  })

  it('still permits everything for a signed-in user on a server without abilities', () => {
    // The rule the logged-out guard must not break: an app that upgrades without opting in keeps
    // its UI. Absent list + a real user = not in use = permitted.
    user.value = { id: 1 }
    const a = useLukkAbilities()

    expect(a.enforced.value).toBe(false)
    expect(a.can('orders.read')).toBe(true)
    expect(a.canAny(['orders.read'])).toBe(true)
    expect(a.canAll(['orders.read'])).toBe(true)
  })
})

describe('the abilities list handed back to consumers', () => {
  it('is a real string[] even when the endpoint sent something else', () => {
    // Typed `string[]`, so `abilities.value?.map(...)` is the obvious thing to write — and it threw
    // on exactly the shapes the matcher was hardened against, because the raw value came off the
    // network. Normalized here so the type is true.
    user.value = { id: 1, abilities: 'admin' }
    const a = useLukkAbilities()

    expect(a.abilities.value).toEqual([])
    expect(() => a.abilities.value?.map(x => x.toUpperCase())).not.toThrow()

    user.value = { id: 1, abilities: [null, 'orders.read', 7] }
    expect(a.abilities.value).toEqual(['orders.read'])
  })
})

describe('lukk\'s own gated routes', () => {
  it('does not hide session management from an ordinary user', () => {
    // lukk's own routes gate PINNED tokens only. Asking `can('lukk.sessions')` directly would hide
    // "sign out other devices" from every normal user, whose derived grant never contains it — and
    // who is never gated anyway.
    user.value = { id: 1, abilities: ['orders.read'] }
    const a = useLukkAbilities()

    expect(a.pinned.value).toBe(false)
    expect(a.can('lukk.sessions')).toBe(false)
    expect(a.canManageSessions.value).toBe(true)
    expect(a.canManageAccount.value).toBe(true)
  })

  it('predicts the refusal for a machine token', () => {
    user.value = { id: 1, abilities: ['ci.deploy'], token_pinned: true }
    const a = useLukkAbilities()

    expect(a.pinned.value).toBe(true)
    expect(a.canManageSessions.value).toBe(false)
    expect(a.canManageAccount.value).toBe(false)
  })

  it('lets a machine token through once it pins the ability', () => {
    user.value = { id: 1, abilities: ['ci.deploy', 'lukk.sessions'], token_pinned: true }
    const a = useLukkAbilities()

    expect(a.canManageSessions.value).toBe(true)
    expect(a.canManageAccount.value).toBe(false)
  })

  it('grants neither when logged out', () => {
    user.value = null
    const a = useLukkAbilities()

    expect(a.canManageSessions.value).toBe(false)
    expect(a.canManageAccount.value).toBe(false)
  })
})

describe('erasing the account is its own ability', () => {
  it('does not treat lukk.account as permission to delete', () => {
    // The server refuses exactly this token (`RequirePinnedAbility:lukk.account.delete`), so gating
    // a "Delete my account" button on `canManageAccount` renders the one button most certain to 403.
    user.value = { id: 1, abilities: ['lukk.account'], token_pinned: true }
    const a = useLukkAbilities()

    expect(a.canManageAccount.value).toBe(true)
    expect(a.canDeleteAccount.value).toBe(false)
  })

  it('accepts the exact ability, and an ordinary session', () => {
    user.value = { id: 1, abilities: ['lukk.account.delete'], token_pinned: true }
    expect(useLukkAbilities().canDeleteAccount.value).toBe(true)

    user.value = { id: 1, abilities: ['orders.read'] } // derived — never gated
    expect(useLukkAbilities().canDeleteAccount.value).toBe(true)

    user.value = null
    expect(useLukkAbilities().canDeleteAccount.value).toBe(false)
  })
})

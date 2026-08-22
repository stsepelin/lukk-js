import { can as coreCan, canAll as coreCanAll, canAny as coreCanAny, enforcesAbilities, LUKK_ACCOUNT, LUKK_SESSIONS, normalize } from 'lukk-core'
import { computed } from '#imports'
import { useLukkAuth } from './useLukkAuth'

/**
 * What the current token may do — reactive, and reads from the loaded user, so it works identically
 * in both transport modes. (In BFF mode the browser never sees the access token that carries the
 * `scope` claim, so lukk publishes the list on the user resource instead.)
 *
 * **UI hints, not enforcement.** The server gates every request on the token itself; this only
 * exists so you don't render a button that comes back 403. Anything that must actually be
 * prevented is prevented server-side.
 *
 * ```vue
 * <script setup>
 * const { can, enforced } = useLukkAbilities()
 * </script>
 *
 * <template>
 *   <button v-if="can('orders.write')">New order</button>
 * </template>
 * ```
 */
export function useLukkAbilities() {
  const { user } = useLukkAuth()

  /**
   * The granted list, or `undefined` when this server doesn't use abilities.
   *
   * Normalized, not handed straight through: `LukkUser.abilities` is typed `string[]` but holds
   * whatever the app's user endpoint sent, so returning it raw would give consumers a type that
   * lies — and `abilities.value?.map(…)`, the obvious thing to write, would throw on exactly the
   * input the matcher was hardened against.
   */
  const abilities = computed<string[] | undefined>(() => normalize(user.value?.abilities))

  /**
   * Whether the server is actually gating on abilities. False when it publishes no list — in which
   * case every `can()` is true, and a UI that hides things on `cannot()` would hide nothing.
   * Useful for a dev-time assertion that your `user.endpoint` really is forwarding the field.
   */
  const enforced = computed(() => enforcesAbilities(abilities.value))

  /** Whether the token holds this ability. `*` and `orders.*` in the GRANT expand; in the check they don't. */
  function can(ability: string): boolean {
    // A logged-out visitor is granted NOTHING. Without this they fall through to the absent-list
    // rule — "this server doesn't use abilities" — and every privileged control renders before
    // anyone has signed in. What shows is the entitlement taxonomy itself: menu items and labels
    // named after abilities.
    if (!user.value) return false

    return coreCan(abilities.value, ability)
  }

  function cannot(ability: string): boolean {
    return !can(ability)
  }

  /** Whether the token holds **any** of them — the `lukk.ability:a,b` gate. */
  function canAny(list: string[]): boolean {
    return user.value ? coreCanAny(abilities.value, list) : false
  }

  /** Whether the token holds **all** of them — the `lukk.abilities:a,b` gate. */
  function canAll(list: string[]): boolean {
    return user.value ? coreCanAll(abilities.value, list) : false
  }

  /**
   * Whether this session is a **machine token** — a pinned grant rather than a human login.
   *
   * lukk's own gated routes apply to these only, which is why the two helpers below exist: asking
   * `can('lukk.sessions')` directly would hide "sign out other devices" from every ordinary user,
   * whose derived grant never contains it and who is never gated anyway.
   */
  const pinned = computed(() => user.value?.token_pinned === true)

  /** Whether `revokeOtherSessions()` and the logout-everywhere routes will be accepted. */
  const canManageSessions = computed(() => !!user.value && (!pinned.value || can(LUKK_SESSIONS)))

  /** Whether step-up and changing the password will be accepted — see `useLukkConfirmation`. */
  const canManageAccount = computed(() => !!user.value && (!pinned.value || can(LUKK_ACCOUNT)))

  return { abilities, enforced, pinned, can, cannot, canAny, canAll, canManageSessions, canManageAccount }
}

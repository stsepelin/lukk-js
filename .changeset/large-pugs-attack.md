---
"lukk-core": minor
"lukk-nuxt": minor
---

**Abilities / scopes** — the client half of lukk 0.6's coarse authorization.

`useLukkAbilities()` exposes `can` / `cannot` / `canAny` / `canAll` over the current token's grant,
reactive and identical in both transport modes:

```vue
<script setup>
const { can } = useLukkAbilities()
</script>

<template>
  <button v-if="can('orders.write')">New order</button>
</template>
```

The list is read from the loaded user — lukk's `UserResource` publishes it — because in BFF mode the
browser never sees the access token that carries the `scope` claim. `lukk-core` exports the matcher
(`can`, `cannot`, `canAny`, `canAll`) for use outside Nuxt, and `LukkUser` gains `abilities?:
string[]`.

**These are UI hints, never enforcement.** The server gates every request on the token itself; this
only lets you avoid rendering a button that comes back 403.

`abilities` being **absent** means the server doesn't use them, and `can()` returns **true** — an
app that upgrades without opting in must not find its UI blanked. `[]` means it does use them and
this token was granted nothing, so `can()` returns false. `enforced` tells the two apart.

A **logged-out** visitor is granted nothing. Falling through to the absent-list rule rendered every
privileged control before anyone had signed in — and what renders is the entitlement taxonomy
itself, menu items and labels named after the abilities. A signed-in user on a server that publishes
no list still gets everything, which is the rule that keeps an un-opted-in app's UI intact.

**`canManageSessions` / `canManageAccount`** predict lukk's *own* gated routes, which apply to a
**pinned** token only. `can('lukk.sessions')` is the wrong question there: an ordinary user's derived
grant never contains it and they are never gated, so gating "sign out other devices" on it would hide
the button from everyone. lukk's `UserResource` now publishes `token_pinned` alongside `abilities`,
exposed as `pinned`, and `LUKK_SESSIONS` / `LUKK_ACCOUNT` are exported from `lukk-core`.

**Abilities follow a refreshed token.** They are re-derived on every mint server-side — that is what
makes revoking one take effect within `access_ttl` rather than lasting the life of the refresh token
— but the client only learns a grant through the user resource, which nothing reloaded on refresh.
A refreshed token therefore carried a new grant while the UI kept rendering from the old one: a
control stayed visible until it 403'd, or a newly-granted one stayed hidden, until something else
happened to reload the user. The single-flight refresh now reloads it, and only when the loaded user
actually publishes `abilities`, so an app that doesn't use the feature pays nothing.

A step-up that can never succeed no longer **deadlocks the confirmation modal**. A 403 from
`confirmPassword` / `confirmPasskey` means this token may never earn a confirmation — a machine token
without `lukk.account` — so the pending step-up is abandoned instead of waiting for a flag that
cannot flip while each retry burns the shared throttle.

A **malformed** `abilities` value fails closed. `abilities?: string[]` is a compile-time claim about
a JSON body the app's own user endpoint produces, and a single-role app returning `abilities:
"admin"` used to make every helper throw a `TypeError` — which, from a `v-if="can('x')"`, takes the
whole component render down. A present-but-unreadable value now grants nothing (the direction the
server takes, where a non-string `scope` claim maps to an empty grant); non-string entries inside a
real array are dropped — as are entries the *server* would have refused at mint (a comma, whitespace,
over 128 bytes), so the client's rule is a subset of the server's by construction rather than by
agreement. A non-string **ability** is refused too: `can()` used to throw on one, but only for users
holding a wildcard grant, so a narrow-grant developer saw `false` while the admin got a blank
component. Only a genuinely absent value still means "not in use". `enforcesAbilities()`
is exported for the distinction.

The matcher mirrors `Lukk\Support\Abilities` exactly — `*` and `orders.*` expand in the *grant* but
never in the *check* (so a caller can't widen their own question by asking `can('orders.*')`),
`orders.*` doesn't cover the bare `orders`, and comparison is case-sensitive. The conformance suite
runs both implementations against the same gates on a live lukk and requires them to agree, so the
two can't drift.

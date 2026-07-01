# Confirmation

Some actions are too sensitive to allow on the strength of an old login — changing 2FA, managing passkeys. lukk gates those behind **step-up ("sudo") confirmation**: the user re-proves their identity, and for a short window afterwards the sensitive routes open up. `useLukkConfirmation` is the client for that.

> [!NOTE]
> This is the client for lukk's server-side step-up — see [Confirmation on the lukk side](https://stsepelin.github.io/lukk/confirmation) for the routes and how it gates your own.

- [`useLukkConfirmation`](#composable)
- [How It Works](#how)
- [Confirming with a Password](#password)
- [Confirming with a Passkey](#passkey)
- [Gated Actions](#gated)

<a name="composable"></a>
## `useLukkConfirmation`

```ts
const {
  confirmed,        // ComputedRef<boolean> — is a confirmation currently held?
  required,         // Ref<boolean> — a withConfirmation() action is waiting on your modal
  token,            // Ref<string | null>
  confirmPassword,  // (password) => Promise<void>
  withConfirmation, // <T>(action: () => Promise<T>) => Promise<T> — per-action modal flow
  cancel,           // () => void — abort a pending withConfirmation
  clear,            // () => void
} = useLukkConfirmation()
```

<a name="how"></a>
## How It Works

When you confirm, the token is **automatically attached** in the `X-Lukk-Confirmation` header on every subsequent request — so once `confirmed` is `true`, the gated actions simply work, until the window expires server-side (lukk's [`confirm.ttl`](https://stsepelin.github.io/lukk/confirmation#configuration)). You never thread the token through your own calls.

Where the token lives depends on the [mode](transport-modes.md):

- **`direct`** — the token is stored in client state and the client attaches the header.
- **`bff`** — the proxy strips the token from the response and **holds it server-side**, injecting the header itself. The browser only sees `confirmed` flip to `true`; it never holds the confirmation credential.

```mermaid
sequenceDiagram
    participant App
    participant Lukk as lukk
    App->>Lukk: confirmPassword(password)
    Lukk-->>App: { confirmation_token }
    Note over App: token stored · confirmed = true
    App->>Lukk: sensitive action (token auto-attached)
    Lukk-->>App: 200
```

You never thread the token through your own calls — earning it is the only step.

<a name="password"></a>
## Confirming with a Password

```ts
const { confirmPassword, confirmed } = useLukkConfirmation()

await confirmPassword(currentPassword)
// confirmed.value === true
```

A wrong password throws a typed [`LukkError`](core.md#errors). Call `clear()` to drop the confirmation early (it also clears on [logout](authentication.md#logout)).

<a name="passkey"></a>
## Confirming with a Passkey

A passkey can satisfy step-up too — see [Passkeys → Step-Up](passkeys.md#confirm):

```ts
const { confirm } = useLukkPasskeys()
await confirm() // stores the confirmation token, same as confirmPassword
```

<a name="gated"></a>
## Gating: per-action or per-page

These actions require a held confirmation; without one, lukk responds `423 Locked`:

- [Managing 2FA](two-factor-authentication.md#management) — enable, confirm, disable, regenerate recovery codes
- [Registering or removing a passkey](passkeys.md#manage)

Two shapes, both supported.

### Per-action (a modal)

Wrap the sensitive call in `withConfirmation()`. It runs the action and, on a `423`, opens your modal (`required`), waits for a fresh confirmation, and retries once:

```ts
const { withConfirmation } = useLukkConfirmation()
const api = useLukkFetch()

async function deleteAccount() {
  await withConfirmation(() => api('/account', { method: 'DELETE' }))
}
```

Bind a global step-up modal to `required` — the user confirms (password **or** passkey), and the pending action retries automatically:

```vue
<script setup lang="ts">
const { required, confirmPassword, cancel } = useLukkConfirmation()
const password = ref('')
</script>

<template>
  <dialog :open="required">
    <input v-model="password" type="password" >
    <button @click="confirmPassword(password)">Confirm</button>
    <button @click="cancel">Cancel</button>
  </dialog>
</template>
```

`withConfirmation` drops a stale confirmation on the `423`, so it always re-prompts when the server genuinely requires one (rather than trusting an expired client flag). `cancel()` rejects the pending action.

### Per-page (a section)

To gate a whole page/section instead, use the [`lukk-confirmed`](authentication.md#route-middleware) route middleware — stack it after `lukk-auth`; it sends an unconfirmed user to `/confirm-password`:

```ts
definePageMeta({ middleware: ['lukk-auth', 'lukk-confirmed'] })
```

Confirmation is client-session state, so a hard reload re-confirms. The server's `lukk.confirm` (423) is the real enforcement either way — these client guards are UX.

Next: **[Using lukk-core](core.md)**.

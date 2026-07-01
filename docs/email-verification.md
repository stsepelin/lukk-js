# Email Verification

`useLukkEmailVerification()` pairs with lukk's opt-in [`features.email_verification`](https://stsepelin.github.io/lukk/email-verification). It owns the two things the **client** does — resend the link, and reflect the user's verified state — while the verification click itself happens in the browser, straight from the email.

- [The flow](#the-flow)
- [The composable](#the-composable)
- [The verify callback page](#callback)
- [Gating pages](#gating)

<a name="the-flow"></a>
## The flow

Verification is a **browser navigation, not an XHR**: the link in the email points at lukk's signed API route, which verifies and then **redirects back to your SPA** (lukk's `email_verification.frontend_url`). So the client never posts the verification itself — it only:

1. **Resends** the link (`sendVerificationEmail()`), and
2. **Re-syncs** the user when they land back on your verify page (`syncAfterVerify()`), so `verified` flips and any "verify your email" banner clears.

This sidesteps the cross-origin-signature problem a fetch-relay through the BFF proxy would hit, and works identically in `direct` and `bff` modes.

<a name="the-composable"></a>
## The composable

```ts
const { verified, sending, sendVerificationEmail, syncAfterVerify } = useLukkEmailVerification()
```

| Member | Type | What it is |
|---|---|---|
| `verified` | `ComputedRef<boolean>` | Whether the loaded user's `email_verified_at` is set. |
| `sending` | `Ref<boolean>` | True while a resend is in flight — bind a button's `disabled` to it. |
| `sendVerificationEmail()` | `() => Promise<void>` | Resend the link to the current user (a no-op server-side if already verified; throttled). |
| `syncAfterVerify()` | `() => Promise<void>` | Reload the user (used on the verify callback page). |

`verified` reads the same `useLukkAuth().user` you already load, so your `user.endpoint` must expose `email_verified_at` for it to reflect reality.

```vue
<script setup lang="ts">
const { verified, sending, sendVerificationEmail } = useLukkEmailVerification()
</script>

<template>
  <div v-if="!verified" class="banner">
    Please verify your email.
    <button :disabled="sending" @click="sendVerificationEmail">Resend link</button>
  </div>
</template>
```

<a name="callback"></a>
## The verify callback page

Point lukk's `email_verification.frontend_url` at a page in your app (e.g. `/verify-email`). When the email link bounces the user here (with `?verified=1`), reload the user so the app reflects the new state:

```vue
<!-- pages/verify-email.vue -->
<script setup lang="ts">
const { verified, syncAfterVerify } = useLukkEmailVerification()

await syncAfterVerify() // re-fetch the user; `verified` becomes true
</script>

<template>
  <p v-if="verified">Your email is verified — you're all set.</p>
  <p v-else>We couldn't confirm that link. Try resending it.</p>
</template>
```

<a name="gating"></a>
## Gating pages

To require a verified email before a page renders, branch on `verified` in `definePageMeta`/middleware, or lean on the server: lukk's [`lukk.verified`](https://stsepelin.github.io/lukk/email-verification#gating-routes) middleware returns a **409** for unverified users, so an app-API call through `useLukkFetch` to a gated route surfaces that status for you to handle.

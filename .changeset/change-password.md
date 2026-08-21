---
"lukk-core": minor
"lukk-nuxt": minor
---

Add `changePassword` and `useLukkPassword` for lukk's new `POST /auth/password`.

The signed-in counterpart to the reset flow: no emailed token, because `current_password` is the proof. That's the point of the endpoint — a stolen access token alone must not be enough to take an account over permanently, which is exactly what changing the password would do.

```ts
const { changePassword, changing } = useLukkPassword()

await changePassword({
  current_password: current.value,
  password: next.value,
  password_confirmation: confirm.value,
})
```

lukk revokes every **other** session on success and keeps the current one, so there is no token to swap and nothing to re-login — the composables' state is already correct afterwards. A wrong current password is a `422` on `current_password`, which [`useLukkForm`](https://stsepelin.github.io/lukk-docs/use-lukk-form) maps onto your fields; the endpoint shares lukk's step-up throttle, so a burst of wrong guesses is a `429` and, where the account lockout is enabled, eventually a `423`.

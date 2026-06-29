# lukk-nuxt

Nuxt module for **[lukk](https://github.com/stsepelin/lukk)** — first-party Laravel JWT
auth. SSR / SPA / SSG, Nuxt 3 **and** 4, in **BFF** or **direct** mode — one composable
API either way.

```bash
npm i lukk-nuxt
```

## Setup

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ['lukk-nuxt'],
  lukk: {
    baseURL: 'https://api.example.com/auth', // your lukk auth routes
    mode: 'bff',                             // 'bff' (default) or 'direct'
    user: { endpoint: '/api/me' },           // your app's authenticated user route
  },
})
```

In **`bff`** mode also set a session secret (≥ 32 chars):

```dotenv
NUXT_LUKK_SESSION_PASSWORD=change-me-to-a-long-random-string
```

## Modes

| Mode | How | Use for |
|---|---|---|
| **`bff`** (default) | A Nitro proxy holds tokens in a sealed cookie; the browser never sees a token. | SSR / served SPA — most secure. |
| **`direct`** | The client talks to lukk directly (no proxy). | SSG / static, or a simple SPA. |

`mode` is a config switch — your app code never changes between them.

## Composables (auto-imported)

```vue
<script setup lang="ts">
const { user, loggedIn, login, logout, pendingTwoFactor, verifyTwoFactor } = useLukkAuth()
const { enable, confirm, disable, recoveryCodeCount } = useLukkTwoFactor()
const { confirmPassword } = useLukkConfirmation()
const { register, login: passkeyLogin, list, remove } = useLukkPasskeys()
</script>
```

- **`useLukkAuth`** — password + 2FA login, logout, session restore, `revokeOtherSessions`, the reactive `user`.
- **`useLukkTwoFactor`** — enrol / confirm / disable / recovery-code count (behind step-up).
- **`useLukkConfirmation`** — earn a step-up confirmation token (auto-attached to gated requests).
- **`useLukkPasskeys`** — register / passwordless login / step-up confirm / list / remove.

Guard pages with the route middleware — `lukk-auth` (require login) or
`lukk-guest` (bounce already-authenticated users, e.g. off `/login`):

```vue
<script setup lang="ts">
definePageMeta({ middleware: 'lukk-auth' })
</script>
```

## Options

| Key | Default | Description |
|---|---|---|
| `baseURL` | `''` | Your lukk auth URL incl. the route prefix. |
| `mode` | `'bff'` | `'bff'` or `'direct'`. |
| `user.endpoint` | `''` | Your app's authenticated user route. |
| `confirmationHeader` | `'X-Lukk-Confirmation'` | Header carrying the step-up token. |
| `session.password` | env `NUXT_LUKK_SESSION_PASSWORD` | BFF sealed-session secret (≥ 32 chars). |

## Documentation

Full guides — installation, configuration, both transport modes, 2FA, passkeys, and
step-up confirmation — live in the [lukk-js docs](https://github.com/stsepelin/lukk-js/tree/main/docs).

## License

MIT

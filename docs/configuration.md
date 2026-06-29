# Configuration

- [Options](#options)
- [`baseURL`](#baseurl)
- [`mode`](#mode)
- [`user.endpoint`](#user-endpoint)
- [`session.password`](#session-password)
- [`confirmationHeader`](#confirmation-header)
- [`storage`](#storage)
- [Overriding with Environment Variables](#env)

<a name="options"></a>
## Options

Everything is configured under the `lukk` key in `nuxt.config.ts`:

| Option | Type | Default | Purpose |
|---|---|---|---|
| `baseURL` | `string` | `''` | Your lukk auth URL, including the route prefix. |
| `mode` | `'bff' \| 'direct'` | `'bff'` | Transport mode — see [Transport Modes](transport-modes.md). |
| `user.endpoint` | `string` | `''` | Your app's authenticated user route. |
| `session.password` | `string` | env | BFF sealed-session secret (≥ 32 chars). |
| `confirmationHeader` | `string` | `'X-Lukk-Confirmation'` | Header carrying the step-up token. |
| `storage` | `string` | `'cookie'` | BFF token storage backend. |

```ts
export default defineNuxtConfig({
  modules: ['lukk-nuxt'],
  lukk: {
    baseURL: 'https://api.example.com/auth',
    mode: 'bff',
    user: { endpoint: '/api/me' },
    confirmationHeader: 'X-Lukk-Confirmation',
    storage: 'cookie',
  },
})
```

<a name="baseurl"></a>
## `baseURL`

The fully-qualified URL of your lukk auth routes, including lukk's route prefix (`lukk.path`, default `auth`):

```ts
baseURL: 'https://api.example.com/auth'
```

In `bff` mode this is read **only on the server** and is never shipped to the browser. In `direct` mode it is part of the public runtime config, because the browser calls lukk directly — so it must be reachable from the browser and [CORS-configured on lukk](transport-modes.md#direct).

> [!NOTE]
> If `baseURL` is empty the module logs a warning at build time. It is the one option you always set.

<a name="mode"></a>
## `mode`

```ts
mode: 'bff' // or 'direct'
```

- **`bff`** (default) — a Nitro proxy holds tokens server-side; the browser never sees one.
- **`direct`** — the client calls lukk directly; the access token lives in memory.

This is the single switch that changes the transport. Your component code does not change. Read [Transport Modes](transport-modes.md) before choosing.

<a name="user-endpoint"></a>
## `user.endpoint`

```ts
user: { endpoint: '/api/me' }
```

A route on **your** backend that returns the authenticated user. lukk-js calls it with the access token attached to populate `useLukkAuth().user`. A path is resolved against the app origin; an absolute URL is used as-is. Unset, `user` stays `null`.

See [Authentication → The Current User](authentication.md#user).

<a name="session-password"></a>
## `session.password`

The secret that seals the BFF token cookie (≥ 32 characters). **Set it via the environment**, not in `nuxt.config.ts`:

```dotenv
NUXT_LUKK_SESSION_PASSWORD=a-long-random-string-of-at-least-32-chars
```

Only used in `bff` mode. Treat it like Laravel's `APP_KEY`: secret, and rotating it logs everyone out.

<a name="confirmation-header"></a>
## `confirmationHeader`

```ts
confirmationHeader: 'X-Lukk-Confirmation'
```

The HTTP header that carries a [step-up confirmation token](confirmation.md). Change it only if you've changed `confirm.header` on the lukk side — the two must match.

<a name="storage"></a>
## `storage`

```ts
storage: 'cookie'
```

The BFF token-storage backend. The default `cookie` is a **stateless sealed cookie** — no server-side store, no Redis, serverless-friendly. You can point it at a [Nitro `useStorage`](https://nitro.build/guide/storage) mount name to keep tokens in a server-side store instead. Ignored in `direct` mode.

<a name="env"></a>
## Overriding with Environment Variables

Because the options become Nuxt [runtime config](https://nuxt.com/docs/guide/going-further/runtime-config), they can be overridden at runtime with `NUXT_`-prefixed environment variables — handy for per-environment deploys:

| Variable | Overrides |
|---|---|
| `NUXT_LUKK_SESSION_PASSWORD` | `session.password` (server-only) |
| `NUXT_LUKK_BASE_URL` | the server-side `baseURL` (BFF) |
| `NUXT_PUBLIC_LUKK_BASE_URL` | the public `baseURL` (direct) |

Next: **[Authentication](authentication.md)**.

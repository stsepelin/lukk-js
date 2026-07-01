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
| `user.endpoint` | `string` | `''` | Your app's authenticated user route (per-mode — see [`user.endpoint`](#user-endpoint)). |
| `api.path` / `api.target` / `api.forceJson` | `string` / `string` / `bool` | `''` / `''` / `true` | BFF-only app-API proxy — see [`api`](#api). |
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

This is the single switch that changes the transport. Your component code does not change. Read [Transport Modes](transport-modes.md) before choosing, and pair it with lukk's [output mode](https://stsepelin.github.io/lukk/configuration#output-mode) on the server (`direct` ↔ cookie mode, `bff` ↔ body mode).

<a name="user-endpoint"></a>
## `user.endpoint`

```ts
user: { endpoint: '/api/me' }
```

A route on **your** backend that returns the authenticated user, used to populate `useLukkAuth().user` (unset → `user` stays `null`). It is **mode-dependent**:

- **`direct`** — a path or absolute URL; the access token is attached as a `Bearer` header.
- **`bff`** — the browser has no token, so this **must be a same-origin path authenticated server-side**: a path under the [`api`](#api) proxy (e.g. `/api/me`), or your own route using `getLukkAccessToken(event)`. No header is attached client-side.

See [Authentication → The Current User](authentication.md#user) and [Transport Modes → Authenticating your own API](transport-modes.md#bff).

<a name="api"></a>
## `api` (BFF app-API proxy)

```ts
api: { path: '/api', target: 'https://api.example.com', forceJson: true }
```

BFF-only and opt-in. Forwards `${path}/**` to the **fixed** `target` (your Laravel API), injecting the access token server-side — so the browser authenticates to your own API without ever holding a token. `target` is never derived from the request (SSRF-safe); non-GET requests with a foreign `Origin` are rejected (CSRF); the inbound `Cookie`/`Authorization` + spoofable `X-Forwarded-*` are stripped; upstream `Set-Cookie` is stripped; and `/api/_lukk/**` is never proxied.

- **`forceJson`** (default `true`) sets `Accept: application/json` on forwarded requests so a JSON API renders clean `401`/`422` JSON for unauthenticated/validation errors — instead of Laravel's default guest-redirect, which 500s behind a proxy (`shouldRenderJsonWhen` does **not** fix that — see [Transport Modes](transport-modes.md#bff)). Set `false` to forward the browser's `Accept` instead — only if a route under `path` legitimately serves a non-JSON response.

> [!TIP]
> Call the proxied API with [`useLukkFetch()`](transport-modes.md#use-lukk-fetch) — a plain `$fetch` forwards no cookie during SSR and silently `401`s. It also rejects with a typed `LukkError` (`{ message, status, errors }`).

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

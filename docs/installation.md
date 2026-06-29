# Installation

- [Requirements](#requirements)
- [Install the Module](#install)
- [Configure It](#configure)
- [The User Endpoint](#user-endpoint)
- [BFF Mode: the Session Secret](#session-secret)
- [Nuxt 3 and 4](#nuxt-versions)

<a name="requirements"></a>
## Requirements

- A [lukk](https://github.com/stsepelin/lukk)-powered Laravel API (`^0.1`)
- Node `>= 20`
- Nuxt `3` or `4`

This page covers the Nuxt module. To use the client without Nuxt, see [Using lukk-core](core.md).

<a name="install"></a>
## Install the Module

```bash
npm i lukk-nuxt      # or: pnpm add lukk-nuxt · yarn add lukk-nuxt
```

Add it to `nuxt.config.ts`:

```ts
export default defineNuxtConfig({
  modules: ['lukk-nuxt'],
})
```

<a name="configure"></a>
## Configure It

All configuration lives under the `lukk` key:

```ts
export default defineNuxtConfig({
  modules: ['lukk-nuxt'],
  lukk: {
    baseURL: 'https://api.example.com/auth', // your lukk auth routes (incl. the prefix)
    mode: 'bff',                             // 'bff' (default) or 'direct'
    user: { endpoint: '/api/me' },           // your app's authenticated user route
  },
})
```

`baseURL` points at lukk's route prefix (default `auth`). Every option is documented in [Configuration](configuration.md).

> [!NOTE]
> In `bff` mode the `baseURL` is used **only on the server** — it is never exposed to the browser, which talks to the same-origin proxy at `/api/_lukk`. In `direct` mode it is public, since the browser calls lukk itself.

<a name="user-endpoint"></a>
## The User Endpoint

lukk issues the token; **your app owns the user resource.** Point `user.endpoint` at a route on your own backend that returns the authenticated user — lukk-js calls it (with the access token attached) to populate `useLukkAuth().user`.

```ts
lukk: {
  // …
  user: { endpoint: '/api/me' },
}
```

It can be a path resolved against your app origin, or an absolute URL. Leave it unset and `user` stays `null` (you can still drive `loggedIn` yourself). See [Authentication → The Current User](authentication.md#user).

<a name="session-secret"></a>
## BFF Mode: the Session Secret

In `bff` mode the proxy seals the tokens into an encrypted server-side cookie, which needs a secret of **at least 32 characters**. Set it via env (never commit it):

```dotenv
# .env
NUXT_LUKK_SESSION_PASSWORD=a-long-random-string-of-at-least-32-chars
```

Generate one with `openssl rand -base64 32`. This is the BFF equivalent of Laravel's `APP_KEY`: it's the **confidentiality boundary** for the sealed tokens (anyone who has it can unseal a session cookie and read the access + refresh tokens), it must be **identical across every server instance** (a load-balanced deploy with per-instance secrets silently invalidates sessions), and rotating it logs everyone out.

> [!NOTE]
> `direct` mode has no server-side session, so it needs no secret.

<a name="nuxt-versions"></a>
## Nuxt 3 and 4

The module supports Nuxt 3 (`>= 3.13`) and Nuxt 4 — no version-specific configuration. It registers:

- the composables (`useLukkAuth`, `useLukkTwoFactor`, `useLukkConfirmation`, `useLukkPasskeys`), auto-imported;
- the route middleware `lukk-auth` and `lukk-guest`;
- a client plugin that restores an existing session on load;
- in `bff` mode, the Nitro proxy at `/api/_lukk/**`.

Next: **[Authentication](authentication.md)**.

# lukk-js

[![lukk-nuxt version](https://img.shields.io/npm/v/lukk-nuxt.svg?style=flat-square&label=lukk-nuxt)](https://www.npmjs.com/package/lukk-nuxt)
[![lukk-core version](https://img.shields.io/npm/v/lukk-core.svg?style=flat-square&label=lukk-core)](https://www.npmjs.com/package/lukk-core)
[![CI](https://img.shields.io/github/actions/workflow/status/stsepelin/lukk-js/ci.yml?branch=main&label=ci&style=flat-square)](https://github.com/stsepelin/lukk-js/actions/workflows/ci.yml)
[![Coverage](https://img.shields.io/badge/coverage-100%25-brightgreen.svg?style=flat-square)](https://github.com/stsepelin/lukk-js/actions)
[![License](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](LICENSE.md)

JavaScript/TypeScript clients for **[lukk](https://github.com/stsepelin/lukk)** — minimal-dependency JWT authentication for first-party Laravel apps, plus an auth-aware fetch and reactive forms for talking to your own Laravel API correctly. Nuxt first; the core is framework-agnostic, so more bindings can follow.

> **Unofficial companion to lukk.** Not affiliated with or endorsed by the Laravel or Nuxt teams. "Laravel" and "Nuxt" are referenced only to describe compatibility and design influence.

> **Pre-1.0 — expect breaking changes.** `lukk-core` and `lukk-nuxt` are in the `0.x` series and versioned in lockstep. Both are fully tested (100% coverage), but per [semantic versioning for initial development](https://semver.org/#spec-item-4), the public API and composable surface may change between minor versions without a major bump. Pin exact versions and read the [UPGRADE guide](UPGRADE.md) (and each package's `CHANGELOG.md`) before upgrading. The 1.0 release will mark API stability.

## Features

- **One composable API, every rendering mode** — the same `useLukkAuth()` works in SSR, SPA, and SSG.
- **Two transport modes, a config switch apart** — a [**BFF**](https://stsepelin.github.io/lukk-docs/transport-modes) proxy that keeps tokens server-side (the browser never sees a token), or [**direct**](https://stsepelin.github.io/lukk-docs/transport-modes) calls straight to lukk (the only option for fully static sites).
- **The whole lukk surface** — [login](https://stsepelin.github.io/lukk-docs/authentication), token refresh, logout, session revocation, [two-factor](https://stsepelin.github.io/lukk-docs/two-factor-authentication), [step-up confirmation](https://stsepelin.github.io/lukk-docs/confirmation), and [passkeys](https://stsepelin.github.io/lukk-docs/passkeys).
- **Call your own API, correctly** — [`useLukkFetch()`](https://stsepelin.github.io/lukk-docs/use-lukk-fetch) is a typed, auth-aware fetch for *your* Laravel API: authenticated in every context (a plain `$fetch` silently 401s in SSR), single-flight 401 refresh, credentials never leak cross-origin, and a typed Laravel error (`{ message, status, errors }`) ready to bind to a form.
- **Forms, bound to Laravel validation** — [`useLukkForm()`](https://stsepelin.github.io/lukk-docs/use-lukk-form) is a reactive form in the spirit of Inertia's `useForm`: submit `data`, bind a `422` bag to per-field errors, with `processing` / `isDirty` / lifecycle hooks and automatic `multipart/form-data` for file uploads.
- **Silent refresh, single-flight** — a 401 transparently refreshes and retries; a burst of 401s triggers exactly one refresh.
- **Typed end to end** — the lukk HTTP contract mirrored in TypeScript, [conformance-tested](https://stsepelin.github.io/lukk-docs/architecture#conformance) against a real lukk instance so it can't drift.
- **Tiny** — `lukk-core` has zero runtime dependencies; `lukk-nuxt` adds only `@nuxt/kit` + `defu`.

## Packages

| Package | What it is |
|---|---|
| **[`lukk-core`](packages/core)** | Framework-agnostic: the lukk HTTP **contract** types, the auth client (token attach + refresh + single-flight), and WebAuthn helpers. Use it directly in any TS app, or as the base for a binding. |
| **[`lukk-nuxt`](packages/nuxt)** | A Nuxt module (Nuxt 3 **and** 4): auto-imported composables, `useLukkFetch()` + `useLukkForm()` for your own API, route middleware, the BFF proxy, and the transport wiring. |

## Transport modes

`mode` is a config switch — **your app code never changes between them.**

| Mode | How it works | Reach for it when |
|---|---|---|
| **`bff`** (default) | A Nitro proxy holds tokens in a sealed, server-side cookie; the browser only ever talks to your own origin. | SSR or a served SPA — the most secure option, no token in the browser. |
| **`direct`** | The client calls lukk directly. Access token in memory, refresh token in lukk's `__Host-` cookie. | A fully static site (SSG), or a simple SPA with no runtime server. |

See **[Transport Modes](https://stsepelin.github.io/lukk-docs/transport-modes)** for the security trade-offs and the SSR/SPA/SSG matrix.

## Requirements

- A [lukk](https://github.com/stsepelin/lukk)-powered Laravel API (latest `0.x` recommended — the newest client features track the latest lukk; e.g. registration needs lukk `>= 0.4`)
- Node `>= 20`
- Nuxt `3` or `4` (for `lukk-nuxt`)

## Quick start

```bash
npm i lukk-nuxt
```

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

```vue
<script setup lang="ts">
const { user, loggedIn, login, logout } = useLukkAuth()

async function onSubmit() {
  await login({ email: email.value, password: password.value })
}
</script>
```

In `bff` mode, also set a session secret (≥ 32 chars): `NUXT_LUKK_SESSION_PASSWORD=…`. See **[Installation](https://stsepelin.github.io/lukk-docs/installation)** for the full walkthrough.

## Documentation

📚 **Full documentation: [stsepelin.github.io/lukk-docs](https://stsepelin.github.io/lukk-docs)**

lukk-js (this client) and [lukk](https://github.com/stsepelin/lukk) (the Laravel package) are documented together on one site — each feature page covers both the server and the client. Start with the [Introduction](https://stsepelin.github.io/lukk-docs/introduction) or jump to [Installation](https://stsepelin.github.io/lukk-docs/installation).

Planned and deliberately-deferred work is tracked in [`ROADMAP.md`](ROADMAP.md).

**For AI assistants:** the docs are exposed as [`/llms.txt`](https://stsepelin.github.io/lukk-docs/llms.txt) + [`/llms-full.txt`](https://stsepelin.github.io/lukk-docs/llms-full.txt) ([llms.txt](https://llmstxt.org) convention), and [`AGENTS.md`](AGENTS.md) has integration + contribution rules.

## Development

```bash
pnpm install
pnpm build        # lukk-core, then lukk-nuxt
pnpm test         # 100% coverage gate on both packages
pnpm lint
pnpm dev          # the lukk-nuxt playground
```

## Acknowledgements

lukk-js is the client half of **[lukk](https://github.com/stsepelin/lukk)** and mirrors its HTTP contract; it also borrows liberally from the Laravel and Nuxt ecosystems. Sincere thanks to their authors and maintainers — lukk-js is an unofficial companion, not affiliated with or endorsed by any of them (see the note at the top); these are simply the works that shaped it:

- **[Inertia.js](https://inertiajs.com)** — `useLukkForm` is modelled on Inertia's `useForm`: the `data` / `processing` / `errors` / `isDirty` surface, `422` error-bag binding, and `remember` semantics all follow its lead.
- **[Nuxt](https://nuxt.com)** — the module + auto-imported composable design, and the SSR/BFF story (a Nitro proxy holding tokens server-side) build directly on Nuxt's server/client model.
- **[Laravel Sanctum](https://laravel.com/docs/sanctum) & [Fortify](https://laravel.com/docs/fortify)** — the auth contract lukk-js speaks, and its customization philosophy, originate here (via [lukk](https://github.com/stsepelin/lukk)).
- **[VueUse](https://vueuse.org)** — the reference for ergonomic, composition-first composable API shapes.
- **[unjs](https://unjs.io)** — `lukk-core` and the BFF proxy are built on **[ofetch](https://github.com/unjs/ofetch)** and **[h3](https://github.com/unjs/h3)** / Nitro.

And the tooling: **[changesets](https://github.com/changesets/changesets)** (releases), **[unbuild](https://github.com/unjs/unbuild)** + **[@nuxt/module-builder](https://github.com/nuxt/module-builder)** (builds), and **[Vitest](https://vitest.dev)** (the 100%-coverage gate) — plus the [Nuxt](https://nuxt.com) and [Laravel](https://laravel.com) communities that make all of this possible. 🙏

## License

MIT.

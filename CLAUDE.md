# CLAUDE.md — `lukk-js`

JavaScript/TypeScript clients for the [`lukk`](https://github.com/stsepelin/lukk) Laravel JWT auth package. A pnpm monorepo: **`lukk-core`** (framework-agnostic contract types + auth client + WebAuthn helpers, zero runtime deps) and **`lukk-nuxt`** (a Nuxt 3/4 module built on the core). The clients mirror lukk's HTTP contract and are conformance-tested against a real lukk instance so the types can't drift.

User-facing docs live in the separate **[lukk-docs](https://github.com/stsepelin/lukk-docs)** repo (a unified VitePress site covering both this client and the lukk PHP package, published to stsepelin.github.io/lukk-docs). Edit docs there — this repo no longer has a `docs/` directory. The lukk PHP source is the contract source of truth.

## Commands

```bash
pnpm install
pnpm build                     # lukk-core (unbuild) then lukk-nuxt (module-builder)
pnpm test                      # both packages, 100% coverage gate (vitest v8)
pnpm typecheck                 # tsc (core) + nuxi typecheck (nuxt)
pnpm lint                      # eslint flat config (@nuxt/eslint-config)
pnpm dev                       # the lukk-nuxt playground
pnpm --filter lukk-core test:conformance   # against a live lukk (see conformance/)
```

## Architecture

- **Two layers.** `lukk-core` knows the lukk contract and how to *speak* it — nothing about storage, reactivity, or a framework. `lukk-nuxt` supplies those by wiring the core's **hooks**. A future `lukk-react` reuses the core unchanged.
- **The hooks seam.** `createLukkClient(hooks)` is the only seam: `getAccessToken`/`onTokens` (read/persist the token), `refresh`, `getConfirmationToken`. The client attaches the bearer, refreshes once on a 401, and **single-flights** concurrent refreshes. *Where* tokens live is the binding's call.
- **Two transport modes, one composable API** (`mode` config switch — component code never changes): **`bff`** (default) proxies through a Nitro handler (`runtime/server/bff.ts`) that holds tokens in a sealed cookie; **`direct`** calls lukk from the browser (access token in memory, refresh in lukk's `__Host-` cookie). `bff` ⇄ lukk body mode (`cookie_mode=false`); `direct` ⇄ lukk cookie mode (`cookie_mode=true`).
- **Composables** (auto-imported): `useLukkAuth` (login + 2FA challenge, logout, sessions, restore, user), `useLukkTwoFactor` (manage), `useLukkConfirmation` (step-up), `useLukkPasskeys` (register/login/confirm/list/remove). Route middleware: `lukk-auth`, `lukk-guest`.
- **Shared `useState` keys** live in `runtime/keys.ts` — never re-type the literals.

## Security invariants — do not break

- **Origin-scope credentials.** `client.ts` attaches `Authorization` / `X-Lukk-Confirmation` / `credentials:'include'` **only** to a same-origin-as-`baseURL` target (`isSameOrigin`). Never attach auth to an absolute, cross-origin URL.
- **The access token must never serialize into the SSR payload.** It lives in `useState('lukk:access')` but is written **client-only** (`if (import.meta.client)` in `plugins/client.ts`). Don't add a server-side token write.
- **The BFF proxy is the security-critical surface.** Keep all of: the sealed session cookie set `SameSite=Strict; Secure; HttpOnly`; the same-origin `Origin` check on non-GET (CSRF); `resolveTarget` containment (the upstream URL must stay same-origin + under lukk's base path — defeats `..`/`%2e%2e`/SSRF); per-session single-flight `refreshOnce` (a rotated refresh token must never be replayed → false family revoke); and **stripping every minted credential** (token pair *and* confirmation token) from responses so the browser holds only the opaque session cookie.
- **Confirmation token stays server-side in BFF.** The proxy captures it, strips it, and injects `X-Lukk-Confirmation` itself; the browser only sees `confirmed` flip true. In `direct` mode it's held in client state and the client attaches it.
- **Refresh tokens are opaque** to lukk-js — never inspected, logged, or persisted beyond handing back to lukk. Token responses are never cached.
- **`isTokenPair` requires `typeof access_token === 'string'`** (not just key presence) — the BFF capture/strip depends on it.
- A throwing `refresh` hook means "not refreshable" (→ `onUnauthenticated`); `request()` wraps it in try/catch so the contract holds for raw `lukk-core` consumers too.

## Quality gate

Both packages enforce **100% coverage** (statements/branches/functions/lines; each `test` runs `--coverage`). The Nuxt runtime is unit-tested via a lightweight `#imports` alias-mock (`test/mocks/imports.ts`) + `h3` mocks for `bff.ts` — no Nuxt boot. The live conformance specs (`packages/core/conformance/`) are excluded from the unit run and gate.

## Gotchas

- **`import.meta.client`** is defined `true` in `packages/nuxt/vitest.config.ts` so the plugin behaves as the client in tests.
- **Conformance completes real ceremonies** — `conformance/authenticator.ts` (pure `node:crypto`, no deps) is a TOTP generator + a software WebAuthn authenticator (P-256 + minimal CBOR) that drive a real 2FA TOTP and a full passkey register→login against live lukk, in both cookie modes, in CI.
- **The fixture pins Laravel 12** (`conformance/fixture/build.sh`) — `web-auth/webauthn-lib` doesn't support Symfony 8 yet; lukk supports `^12|^13`. Throttles are relaxed in the fixture so the suite can replay flows.
- **Default-param trap:** a default parameter applies when the arg is `undefined` — to test a genuinely-absent value (e.g. a session with no `id`), override the field after construction.
- Releases use **changesets** (per-package `CHANGELOG.md` auto-generated) — there is no manual root changelog.

# Roadmap

Deferred and considered work for `lukk-js`. Items here are intentionally **not** built yet —
this is a place to record the decision and rationale so they aren't re-planned. Nothing here is a
commitment or a dated milestone; priorities move with real demand.

The shipped surface (auth composables, `useLukkFetch`, `useLukkForm`, the BFF proxies) lives in the
[docs](docs/README.md).

## Transport

- **Opt-in `Set-Cookie` passthrough** — `api: { forwardSetCookie: ['locale', …] }` to let *named*
  upstream app-API cookies through the BFF proxy, while still stripping everything else and never
  leaking or colliding with the sealed session. **Deferred:** security-sensitive change to the
  proxy. The current, deliberate decision is that **the proxy owns cookies** — it strips all upstream
  `Set-Cookie` and re-emits only lukk's sealed session (see
  [Transport Modes → Cookies & CSRF](docs/transport-modes.md#bff)). This item would add a controlled
  escape hatch for hybrid apps whose Laravel API legitimately sets a browser cookie.

## Client / auth

- **Replace the credential field** — adding extra login fields **shipped** (`login()` /
  `twoFactorChallenge()` accept `LoginInput = LoginCredentials & Record<string, unknown>`; see
  [Authentication → Custom login fields](docs/authentication.md#login)). Still open: a first-class,
  typed way to send a **different** credential field (e.g. `username`/`phone` instead of `email`). The
  backend already supports it via `Lukk::authenticateUsing(Request)`, so today you pass
  `{ email: usernameValue, password }` or a custom object; a typed client seam is a larger design call
  (it trades away the `email`/`password` guardrail).

## Forms — Inertia-parity Tier 3

Beyond the near-`useForm` parity already shipped in [`useLukkForm`](docs/forms.md):

- **Upload progress** (`form.progress`) — **blocked by the platform:** `fetch`/`ofetch` can't stream
  request-upload progress in the browser (Inertia uses `XHR`/axios). Would mean abandoning the
  `useLukkFetch` transport for uploads. Unlikely to ship.
- **Laravel Precognition** — real-time server-side validation (`validate()`, `touch()`,
  `valid`/`invalid`, `validating`). A sizeable feature of its own; only if there's demand.
- **Form state history-remember** — persist form state across SPA history (Inertia's `remember`). The
  Nuxt-native equivalent is `useState`-keyed state — a different paradigm. Low priority.
- **Nested-error auto-mapping** — a helper to bind Laravel's dotted `422` keys (`address.street`,
  `items.0.name`) onto a nested `form.data`. Today `form.errors` is a flat map keyed by the dotted
  path (see [Forms → Validation Errors](docs/forms.md#errors)).

## Maintenance

- **Dev-dependency bump** — clear the dev-toolchain audit advisories (`vitest >= 3.2.6`,
  `vite >= 6.4.3`, `esbuild >= 0.25.0`). These are **not** shipped and **not** CI-reachable (the
  critical one requires the Vitest UI server; the high is Windows-only); production dependencies audit
  clean. Pure hygiene.

## Bindings

- **More framework bindings** — `lukk-react` and friends on top of the framework-agnostic
  `lukk-core`. The monorepo is structured for this from the start.

## AI & tooling

The docs are already AI-consumable via [`/llms.txt`](https://stsepelin.github.io/lukk-js/llms.txt)
+ `/llms-full.txt` and [`AGENTS.md`](AGENTS.md). Deferred:

- **MCP server** — a Model Context Protocol server a user's AI client could connect to for live
  doc search / usage scaffolding (e.g. "scaffold a lukk-nuxt setup"). **Deferred:** needs hosting
  or a published, user-run package plus per-client config and ongoing upkeep. For a docs use-case,
  `llms.txt` already delivers most of the value with none of that — revisit only for a concrete
  interactive tool.

# Roadmap

Deferred and considered work for `lukk-js`. Items here are intentionally **not** built yet —
this is a place to record the decision and rationale so they aren't re-planned. Nothing here is a
commitment or a dated milestone; priorities move with real demand.

The shipped surface (auth composables, `useLukkFetch`, `useLukkForm`, the BFF proxies) lives in the
[docs](docs/README.md).

## Client / auth

- **Custom login fields** — widen the `login()` / `twoFactorChallenge()` request types in `lukk-core`
  so consumers can add fields (`{ email, password, remember, captcha }`) without a `TS` cast. The
  runtime already spreads the payload; only the closed `LoginCredentials` type blocks it. The backend
  already supports custom/replaced credential fields via `Lukk::authenticateUsing(Request)`, and
  registration is app-owned (build it with `useLukkForm`). Non-breaking type widening + a
  "Custom login fields" docs section. Replacing the credential field entirely (email → username) at
  the client is a larger design call (it trades away the email/password guardrail).

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

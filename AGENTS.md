# AGENTS.md

Guidance for AI coding assistants. Two audiences: teams **using** lukk-js in an app, and contributors **working on** this repo.

Docs: <https://stsepelin.github.io/lukk-docs> — a unified site covering both lukk (PHP) and lukk-js, machine-readable at [`/llms.txt`](https://stsepelin.github.io/lukk-docs/llms.txt) and [`/llms-full.txt`](https://stsepelin.github.io/lukk-docs/llms-full.txt). Docs source lives in the [lukk-docs](https://github.com/stsepelin/lukk-docs) repo.

## Using lukk-js in an app

lukk-js is the first-party client for [lukk](https://github.com/stsepelin/lukk) (Laravel JWT auth): `lukk-core` (framework-agnostic) + `lukk-nuxt` (Nuxt 3/4 module). It exists so you **don't hand-roll** token attachment, refresh, or error plumbing.

**Two transport modes, one config switch — app code is identical either way:**
- `bff` (default, most secure) — a Nitro proxy holds tokens in a sealed `__Host-` cookie; the browser never sees a token.
- `direct` — for SSG/static; the access token lives in memory, the refresh token in lukk's `__Host-refresh` cookie.

**Do:**
- Use the composables; don't reimplement what they do.
  - `useLukkAuth()` — login/logout, reactive `user`/`loggedIn`, 2FA (`pendingTwoFactor` → `verifyTwoFactor`), session restore, `revokeOtherSessions`.
  - `useLukkFetch()` — an auth-aware fetch for **your own** Laravel API: single-flight 401 refresh, and it rejects with a typed `LukkError` (`{ status, message, errors }`).
  - `useLukkForm(initial)` — a reactive form: fields live under `form.data.*`; it binds a Laravel `422` bag to per-field `form.errors`; it auto-sends `multipart/form-data` when a field holds a `File`/`Blob`. Use it for login, registration, and any form.
  - `useLukkTwoFactor` / `useLukkPasskeys` / `useLukkConfirmation`, and the `lukk-auth` / `lukk-guest` route middleware.
- Set `NUXT_LUKK_SESSION_PASSWORD` (≥ 32 chars) in `bff` mode.
- Build **registration** yourself — lukk has no register endpoint. POST your form (via `useLukkForm`) to your own Laravel route; the backend mints tokens with `$user->startSession()`.
- Customize login on the **backend** (`Lukk::authenticateUsing`), not the client. To send extra login fields, that's a backend concern; the client's `login()` payload is intentionally minimal.
- Let `LukkError` drive UI: a `422` binds to a form; other statuses rethrow for you to branch on.

**Never:**
- Store the access or refresh token in `localStorage`/`sessionStorage`, or read/persist it yourself — the client owns token storage (memory or the sealed cookie).
- Use a plain `$fetch('/api/...')` for your own API in any **SSR/server** context — it forwards no cookie and silently `401`s. Use `useLukkFetch()` (correct in client, SSR, and server routes) or Nuxt's `useFetch`; in a Nitro route pair with `getLukkAccessToken(event)`.
- Hand-roll bearer attachment or a 401 refresh loop — the client single-flights refresh so a rotating token is never replayed.
- Expect app-API `Set-Cookie` to reach the browser through the BFF proxy — the proxy owns cookies and strips them by design (see the docs).

## Contributing to this repo

See **[`CLAUDE.md`](./CLAUDE.md)** for the full contributor guide. In short: pnpm monorepo; **100% test coverage is enforced** (vitest v8) in both packages; `pnpm lint` + `pnpm typecheck` must pass; changes are additive/opt-in and non-breaking; add a changeset. Run a code review and a security review before committing, and never commit without explicit approval.

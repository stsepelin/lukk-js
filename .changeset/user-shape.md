---
"lukk-core": minor
"lukk-nuxt": minor
---

Accept any reasonable `user.endpoint` shape — especially Laravel's default `{ "data": {...} }` API-Resource wrapper, which previously made `useLukkAuth().user` a `{ data }` object (so `loggedIn` was `true` but every field was `undefined`).

- **lukk-core:** new augmentable `LukkUser` interface (extend it via `declare module 'lukk-core'` to type `useLukkAuth().user` everywhere), plus `shapeUser()` and `isEmailVerified()`.
- **lukk-nuxt:** `fetchUser` now **auto-unwraps** a clean `{ data: {...} }` wrapper (never a `meta`/`links`/`errors` envelope, and `{ data: null }` → logged-out), configurable via `user.key` (default `'data'`; `false` disables). `useLukkAuth().user` is typed `LukkUser | null`, and `verified` accepts Laravel's `email_verified_at` **or** the OIDC boolean `email_verified`. A dev-only `console.warn` fires when a "logged-in" user still looks like an un-unwrapped wrapper (no `id`), pointing at `user.key` / `$wrap = null`.

Pairs with a new optional `Lukk\Http\Resources\UserResource` base class on the PHP side.

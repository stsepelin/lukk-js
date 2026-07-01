---
"lukk-nuxt": patch
---

Add `useLukkForm()` — a reactive form bound to your app API, closely modelled on Inertia's `useForm`.

`useLukkFetch` already rejects with a typed `LukkError` (`{ status, message, errors }`); `useLukkForm` turns that into a form: hold the fields, submit them, and map a Laravel `422` bag onto per-field errors — over the same transport-aware fetch, so it's SSR-correct and identical in BFF and direct mode.

```ts
const form = useLukkForm({ email: '', password: '' })
await form.post('/register')   // form.data is the body
form.errors.email              // ← first 422 message for `email`, if any
form.processing                // ← reactive in-flight flag
```

- Fields live under `form.data.*` (not spread onto the form), so a field may safely be named `errors`, `processing`, or `submit`. Each call returns an independent form.
- **Reactive state:** `errors` (first message per field), `hasErrors`, `processing`, `wasSuccessful`, `recentlySuccessful` (transient "Saved!" flag, duration configurable), and `isDirty`.
- **Verbs:** `post`/`put`/`patch`/`delete`/`get` (get sends fields as the query string), plus the generic `submit(method, url, options?)`. `options` are per-submit `ofetch` overrides plus `onSuccess`/`onError`/`onFinish` lifecycle hooks.
- Each submit clears errors first, re-populates them only from a `422`, always resets `processing`, fires the hooks, and rethrows the `LukkError`; on success it returns the parsed body and re-baselines the defaults (so `isDirty` clears).
- **Mutators (all chainable):** `setError`, `clearErrors(...fields)` (all when bare), `reset(...fields)` / `resetAndClearErrors(...fields)` (from an independent deep copy), `defaults(…)` (re-baseline `reset`/`isDirty`), and `transform(data => payload)` (map the fields sent on each submit).
- **File uploads are automatic:** a `File`/`Blob` anywhere in `data` sends the submit as `multipart/form-data` with Laravel-style bracket keys (`meta[views]`, `tags[0]`); force it with `forceFormData: true`. `form.cancel()` aborts the in-flight submit.

Additive and opt-in; auto-imported like the other `useLukk*` composables. Exposes the `LukkForm<T>` type.

---
"lukk-nuxt": minor
---

`useLukkForm` gains `form.nestedErrors` and a `rememberKey` option.

- **`form.nestedErrors`** — the `422` errors with Laravel's dotted keys (`address.street`, `items.0.name`) expanded into a nested object, so a nested `form.data` can bind `form.nestedErrors.address?.street`. `form.errors` stays the flat, dotted-keyed map.
- **`rememberKey`** — `useLukkForm(initial, { rememberKey: 'signup' })` backs `data` with Nuxt `useState`, so a half-filled form survives SPA navigation and back. The reset/`isDirty` baseline isn't remembered; `isDirty` compares the restored data against the original `initial`.

Both additive and opt-in; no change to existing forms.

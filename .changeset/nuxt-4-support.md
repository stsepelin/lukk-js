---
"lukk-nuxt": minor
---

Develop against Nuxt 4, keep supporting Nuxt 3. `@nuxt/kit` widens to `^3.13.0 || ^4.0.0`; the playground and the conformance apps move to Nuxt 4, and the "oldest supported Nuxt" job still installs the declared 3.x floor — now including the playground, which is its own workspace package. Nuxt 4's tsconfig turns on `noUncheckedIndexedAccess`, which the access-token decoder now satisfies without adding a branch no input can reach.

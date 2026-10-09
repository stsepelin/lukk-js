---
"lukk-nuxt": patch
---

**Packaging and typing fixes.** `LUKK_BFF_PREFIX` and `LUKK_SESSION_COOKIE` can be imported as values again: the published type entry re-exported them type-only, so `import { LUKK_BFF_PREFIX } from 'lukk-nuxt'` failed with TS1362. `h3`, which the server runtime imports, is now a declared dependency rather than a hoisting accident. The internal `refreshOnce` helper is no longer auto-imported into your server code. `$lukk` and `$lukkRefresh` are typed in templates. The loopback-`baseURL` warning no longer fires during `nuxi prepare`/`typecheck`.

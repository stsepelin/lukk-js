---
"lukk-nuxt": patch
"lukk-core": minor
---

**`useLukkFetch` fails closed on credentials, and judges a per-call `baseURL` too.**

The instance was built with `credentials: 'include'` and narrowed per request in an `onRequest` hook. ofetch merges per-call options by *spreading*, so a caller's own `onRequest` **replaces** lukk's — and that call then kept the `include` default and sent the origin's cookies to whatever it was pointed at. The default is now `credentials: 'same-origin'`, *upgraded* to `include` only once the target is known to be same-origin; a call that replaces the hook now under-sends rather than over-sends.

The same-origin decision also looks at a per-call `baseURL`, not just the path: ofetch applies the base **after** the hook runs, so `api('/me', { baseURL: 'https://collector.example' })` looked like a same-origin `/me` at the moment the decision was made, and left with the bearer. An absolute per-call base is now accepted only on the API's own origin — or on this app's, since in BFF mode the API base is the relative proxy mount and no absolute URL can match it. A *relative* per-call base resolves against the document, so it is accepted only where the API base is relative too.

**This can drop credentials a call used to carry.** A call that passes its own `onRequest`, or one that redirects the base to another origin, no longer sends the session cookie or bearer and will `401`. Call lukk's instance without replacing its hook (wrap it instead), and keep authenticated calls on the API's own origin.

`lukk-core` exports `carriesOrigin(url)` — the canonicalisation `isSameOrigin` already used, now shared, which answers whether a URL or base names an origin of its own at all.

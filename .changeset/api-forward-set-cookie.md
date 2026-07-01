---
"lukk-nuxt": minor
---

Add `api.forwardSetCookie` — an opt-in allow-list for passing app-API cookies through the BFF proxy.

By default the app-API proxy owns cookies: it strips **every** upstream `Set-Cookie` and re-emits only lukk's sealed session. For a hybrid app whose Laravel API legitimately sets a browser cookie, list the cookie **names** to let just those through:

```ts
lukk: { mode: 'bff', api: { path: '/api', target: '…', forwardSetCookie: ['locale', 'theme'] } }
```

Everything not on the list is still stripped. The sealed session cookie is **never** forwardable — even if you list its name, an upstream can't overwrite it. Default `[]` (current behavior; non-breaking).

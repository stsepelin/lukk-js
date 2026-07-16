---
"lukk-nuxt": minor
---

Add `session.name` to namespace the BFF sealed-session cookie, so multiple lukk-nuxt apps can share a host without clobbering each other's session. Cookies are scoped by host, not port, so two apps on `localhost:3000` + `:3001` (or two apps under one domain via path routing) otherwise read and overwrite the same `lukk-session` / `__Host-lukk-session` cookie — logging into one silently logs the other out.

Set a distinct slug per app:

```ts
// nuxt.config
lukk: { session: { name: 'admin' } }
// → __Host-lukk-admin-session (Secure)  /  lukk-admin-session (dev http)
```

Unset keeps the existing names (`__Host-lukk-session` / `lukk-session`) byte-for-byte, so this is non-breaking. The full name is derived at each runtime site from the resolved `cookieSecure` + the namespace, so the `__Host-` prefix and the `Secure` attribute always share one source and can't diverge; `Secure`/`Path=/`/no-`Domain` are preserved.

Note: namespacing is **de-confliction for co-hosted apps, not a trust boundary**. Apps sharing an origin (same host + path routing, or `localhost` across ports) share one cookie jar — the per-app `session.password` (the iron seal), not the cookie name, is what isolates them. Put distinct-trust apps on separate subdomains and give each a distinct strong `session.password`.

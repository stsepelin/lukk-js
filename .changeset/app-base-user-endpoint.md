---
"lukk-nuxt": patch
---

**`user.endpoint` resolves under `app.baseURL` in BFF mode**, like the proxy mount it points at — an app served under `/admin/` fetched its user from the origin root. An app that worked around this with a base-prefixed relative endpoint (`'/admin/api/me'` under `/admin/`) now fetches `/admin/admin/api/me`: drop the prefix (see UPGRADE.md). In direct mode `useLukkFetch` no longer prefixes a relative `api.target` with the app's base: there it names an API served beside the app, not a route of it.

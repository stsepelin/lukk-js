---
"lukk-nuxt": patch
---

**BFF mode works under a non-root `app.baseURL`.** Nitro mounts every server route under the app's base path, but the client reached the auth proxy at a root-relative `/api/_lukk`, as did `useLukkFetch`'s relative app-API base and the server's own logout finish — so with `app.baseURL: '/admin/'` every sign-in, refresh and logout went to the origin root. All three now resolve under the base, read at runtime.

**The BFF session cookie survives a browser restart.** It carried no Max-Age, so it was a session cookie: BFF users were signed out whenever the browser closed, while direct-mode users kept lukk's persistent refresh cookie. It now lives for `session.maxAge` (30 days), restarting on every write as the seal does, and a cleared session's cookie is deleted outright.

**A step-up still waiting is cancelled when its session ends.** After a 423, `withConfirmation()` waited for `confirmed` with nothing to stop it, so after a logout — or another account signing in on the tab — the next confirmation resolved it and the old action (a passkey deletion, say) ran unasked. Logout and every sign-in now cancel it.

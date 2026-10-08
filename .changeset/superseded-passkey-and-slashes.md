---
"lukk-nuxt": patch
---

**A passkey sign-in overtaken by a logout ends its own session again.** Since a second `logout()` joins the one in progress, the passkey path's `logout()` for the session it had just been issued joined the logout that went out before that session existed, so the session stayed live: signed back in on the next BFF page load, orphaned upstream in direct mode. Passkey sign-in now completes through the same path as a password sign-in, which ends such a session with a logout of its own.

**Repeated slashes no longer slip past the proxies' route checks.** `/api//auth/login` and `/api/_lukk//refresh` were read as distinct from their single-slash forms, while a slash-merging hop in front of Laravel (nginx's default) delivers them as `/auth/login` and `/auth/refresh`. Route checks now collapse them first.

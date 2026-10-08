---
"lukk-nuxt": patch
---

**A passkey sign-in overtaken by a logout ends its own session again.** Since a second `logout()` joins the one in progress, the passkey path's `logout()` for the session it had just been issued joined the logout that went out before that session existed, so the session stayed live: signed back in on the next BFF page load, orphaned upstream in direct mode. Passkey sign-in now completes through the same path as a password sign-in, which ends such a session with a logout of its own.

**Repeated slashes no longer slip past the proxies' route checks.** `/api//auth/login` and `/api/_lukk//refresh` were read as distinct from their single-slash forms, while a slash-merging hop in front of Laravel (nginx's default) delivers them as `/auth/login` and `/auth/refresh`. Route checks now collapse them first.

**The BFF auth proxy refuses a path lukk could not route as written.** A path with an interior empty segment or an encoded slash or backslash (`/_lukk//logout`, `/_lukk/refresh%2F`) now answers 404 without reaching lukk. Route policy is decided on the path as lukk's router reads it, and such a path had the sealed refresh token injected into a request lukk never routed, so it could reach an app's fallback route. Trailing slashes are still accepted. The internal sign-in symbol moved out of `composables/`, which Nuxt auto-imports into every app.

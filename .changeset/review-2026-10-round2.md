---
"lukk-core": minor
"lukk-nuxt": patch
---

**The app-API proxy reads a `.php` with nothing after it as a front controller too.** Symfony strips `SCRIPT_NAME` as a leading substring, so behind nginx + php-fpm `/api/index.phpauth/login` routed as `/auth/login` and streamed lukk's token pair out. Every `.php` in the path — and in `baseURL` — is now read as the end of a script's name, on every decoding round.

**A response still out keeps the session's head, however long it takes.** The head (the newest refresh token, which tells a late response that the session has moved past its pair) lasted five minutes after the last rotation; an app-API response has no deadline, and one delivering after that re-sealed a spent pair over the newer one — the browser's next refresh was then revoked as a replay. It now lasts ten minutes past the latest rotation, hand-out or response, and for as long as any response that may seal a pair for the session is out (bounded at 50,000 sessions, warned once).

**A logout and a replacing sign-in present the session's current tokens.** After a rotation the browser never received, they sent the cookie's spent refresh token: lukk revoked the family — as a reuse, with a `RefreshTokenReused` theft alarm. They now present the journal's head, and lukk ends the session through the bearer.

**lukk-core: a request made for one account is not replayed as another.** When a `401` renewal comes back for a different account (another tab signed in), the request rejects with `reason: SESSION_CHANGED` instead of being retried; `useLukkFetch` does the same. A `401` from a foreign origin, where no credentials went, is not renewed for at all. `isTwoFactorChallenge` and `isRegistrationPending` accept any value.

**lukk-nuxt.** A sign-in, another tab's session change, or a renewal as another account drops the step-up (`confirmed` and the held token). `useLukkForm`: a new submit aborts the one in flight and a superseded one no longer touches the form's state; dotted error keys and a typed `nestedErrors`. An expired 2FA challenge clears `pendingTwoFactor`. A `null` rejection passes through `useLukkConfirmation` unchanged. The effective `confirmationHeader` (one set through `runtimeConfig` too) is validated. Nested module options are optional field by field; `$lukk` is typed `LukkBffClient` in BFF mode. With `experimental.restoreState`, lukk's session state is kept out of the snapshot Nuxt restores after a reload of its own.

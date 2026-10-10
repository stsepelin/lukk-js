---
"lukk-core": minor
"lukk-nuxt": minor
---

**A 401 is retried in BFF mode once the session has been renewed.** lukk-core retries a request after its `refresh` hook returns a token pair, and the pair is shape-gated (`isTokenPair`) so no arbitrary response body reaches `onTokens`. A BFF proxy renews the session server-side and answers the browser with no token, so that gate refused the answer and lukk-core never retried a 401 in lukk-nuxt's default mode, even right after a successful renewal.

lukk-core now exports `REFRESHED_WITHOUT_TOKEN`, a symbol a `refresh` hook returns to say "renewed, and there is no token for you to hold": the request is retried once and `onTokens` is not called. A symbol can't come out of a response body, so the shape gate on real pairs is unchanged. The hook's type is now `() => Promise<RefreshOutcome>` (`TokenPair | typeof REFRESHED_WITHOUT_TOKEN | null`).

In lukk-nuxt, `$lukkRefresh` and `$lukkRestore` resolve `REFRESHED_WITHOUT_TOKEN` in bff mode instead of the proxy's `{ ok, expires_in }` mislabelled as a `TokenPair`, and never write an access token there; both are still truthy on success. The `#app` types now say so — `$lukkRefresh: () => Promise<RefreshOutcome>` — and `$lukkRestore`, which was provided but untyped, is typed.

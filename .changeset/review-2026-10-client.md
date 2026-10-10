---
"lukk-nuxt": minor
"lukk-core": minor
---

**Direct mode keeps its credentials out of the payload.** The access token, the step-up token and a pending 2FA challenge lived in `useState`, which Nuxt's chunk-reload persists to `sessionStorage` (`nuxt:reload:state`) and `experimental.restoreState` re-applies, stale. They are now held on the Nuxt app; the `lukk:access`, `lukk:confirmation` and `lukk:challenge` state keys are gone.

**`useLukkFetch` sends the step-up token in direct mode** — to the API's own origin only, like the bearer — so a `lukk.confirm`-gated route of the app's API can be confirmed; it answered `423` forever. A relative path with an explicitly empty `baseURL` no longer carries credentials to the page's origin when that is not the API's. App-API errors carry `retryAfter`, read by the newly exported `lukk-core` `retryAfterSeconds()`.

**A 2FA challenge from an earlier attempt is dropped** by any later sign-in that issues tokens, and when another tab changes the session; redeemed later, it replaced the session just begun. **`withConfirmation()` retries once** instead of wiping a confirmation that landed while its request was out. **`useLukkForm`**: a cancelled submit rejects with the `AbortError` itself, and `onFinish` runs even when `onError` throws.

**`login()`, `register()` and passkey `login()` are typed with `BffSignInResult`** (`{ ok: true, expires_in }`), what they resolve to in BFF mode, so `access_token` is not assumed. **`storage` is reserved**: any value but `'cookie'` fails the build — it was read by nothing. The proxies name the setting at fault (`baseURL` or `api.target`) when they cannot resolve their target.

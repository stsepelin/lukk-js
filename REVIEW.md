# REVIEW.md — review rules for `lukk-js`

**Every review of this repository applies these rules.** That covers pull-request bots (Greptile, Copilot), Claude Code and its subagents, and human reviewers. A review that doesn't check a change against the specs below, or doesn't cite the clause a finding rests on, is incomplete. The binding project invariants are in [`CLAUDE.md`](./CLAUDE.md). This file is how a review shows a change keeps them.

Sister files: `lukk/REVIEW.md` (server) and `lukk-docs/REVIEW.md` (documentation). The method, the severity bar and the recurring-defect sections are shared. When one of them changes, change all three.

---

## 1. Method (mandatory)

1. **Scope.** Review the diff *and* every path it touches. For the BFF that means all four places a session cookie is written:
   - the auth proxy (`server/bff.ts`);
   - the app-API proxy (`server/api-proxy.ts`);
   - SSR hydration (`server/hydrate.ts`);
   - finish-logout.

   A fix is reviewed together with the code it fixes.
2. **Map the change to the spec table (§4).** List the clauses that apply and check each one. Report what you checked as well as what failed.
3. **Look for the opposite defect.** Every fix in this repo's history that closed one hole risked opening the inverse one:
   - a replay → a false logout;
   - a refusal → a bypass;
   - a withheld cookie → a stale cookie sealed over a newer one;
   - a sign-out → a request replayed as another account.

   Name the inverse of each fix and show it isn't introduced.
4. **Verify by running it, on a timeline.** Session, journal and refresh bugs are ordering bugs. Reproduce them with the real handlers (real h3 over `node:http`, the fake-lukk harnesses, fake timers) and write the timeline down: which request starts, which await it is in, and which response lands first. A finding is CONFIRMED only when reproduced. Anything you only reasoned out is PLAUSIBLE.
5. **Check the tests pin the change.** Run every new test against the parent commit's `src/`. A test that passes there pins nothing.
6. **Report format.** For each finding give: severity (§2), `file:line`, the timeline or input, the clause or invariant broken, and the minimal fix. Order findings most severe first. Put deliberate deviations (§6) and below-the-bar items in a separate list.

## 2. Severity and the release bar

| Severity | Meaning |
|---|---|
| **Blocker** | An unauthenticated user, a malicious site, or an ordinary user's normal use (several tabs, slow networks, reloads, navigation, sign-in, logout, account switch) can trigger it, on a standard setup. The impact is one of:<br>• a token or secret leak (to the bundle, the SSR payload, `sessionStorage`, logs or a third party)<br>• CSRF or login-CSRF<br>• an open path to lukk's credential routes<br>• SSRF<br>• a false logout or a false `RefreshTokenReused` family revoke<br>• a user shown as, or acting as, the wrong account<br>• one request that hangs or blocks the server<br>• a broken documented flow |
| **Major** | The same impacts, but only with a documented non-default option (`ssrHydrate: false`, a shared session store, a custom `clientIpHeader`, several instances) or an unusual deploy layout. |
| **Minor** | Hardening, typing, wording, docs drift. |

A **standard setup** is BFF or direct mode with the documented defaults, Nuxt 3 or 4 on Node.

Blockers stop a merge. Majors are fixed before release, or recorded as a known limitation with the reason. Minors go into an issue.

## 3. What a review must always run

```bash
pnpm lint
pnpm typecheck                               # core + playground in direct AND bff mode
pnpm test                                    # 100% coverage, core and nuxt
pnpm --filter lukk-nuxt test:integration     # real sockets
pnpm build
pnpm test:mutation                           # Stryker on the changed ranges at least; 0 survivors
```

Also run conformance against a real lukk (see `conformance/README.md`) whenever a change touches the wire contract, the types that mirror lukk's responses, or the flows. That means: login, refresh, logout, step-up, 2FA, passkeys, export and erasure.

## 4. The specifications lukk-js relies on

### 4.1 Token handling in the browser — OAuth for browser-based apps

| Clause | Requirement in lukk-js | Review checks |
|---|---|---|
| draft-ietf-oauth-browser-based-apps (BFF pattern) | In BFF mode the browser holds **no** token. | Every minted credential is captured and stripped by the proxy before the browser sees the response: the access token, the refresh token, the confirmation token, and the 2FA challenge where applicable. Only the opaque sealed cookie reaches the browser. |
| same draft (browser-held tokens) | In direct mode the access token lives only in memory. | No secret goes into `useState`, the SSR payload, `localStorage` or `sessionStorage`, including Nuxt's `reloadNuxtApp({ persistState })` copy. Secrets go through `runtime/utils/secrets.ts`, written client-only, and `reload-state.ts` strips `$slukk:*`. |
| RFC 6749 §5.1, RFC 9111 | Token responses are not cached. | `Cache-Control: no-store` on anything carrying a token or session. Nothing user-specific is heuristically cacheable (RFC 9111 §4.2.2). Where a response varies, `Vary` is merged in, never overwritten (RFC 9111 §4.1). |
| RFC 9700 §4.14.2 | A rotated refresh token is never replayed. | Refresh is single-flight per session (`refreshOnce`) and never aborted mid-rotation. Every response that seals a pair goes through `deliverPair`/`currentPair`, so the cookie that leaves is the newest one. The journal's answer to a replay is a deliberate deviation (§6). |
| RFC 7519 / RFC 9068 | Reading claims. | Refresh tokens are opaque: never decoded, logged or persisted beyond handing them back to lukk. The access token's `exp` is read only to refresh proactively, and `sub` only to detect `SESSION_CHANGED`. `isTokenPair` requires string tokens. |
| RFC 6454 | Same origin. | `Authorization`, `X-Lukk-Confirmation` and `credentials: 'include'` are attached only to a target same-origin as `baseURL` (`isSameOrigin`). A 401 renews only for same-origin targets. |

### 4.2 Cookies and CSRF

| Clause | Requirement in lukk-js | Review checks |
|---|---|---|
| RFC 6265bis §5.6, §5.7 | The sealed session cookie. | `__Host-` prefix, `Secure`, `HttpOnly`, `SameSite=Strict`, `Path=/`, no `Domain`. The seal expires with `session.maxAge`. Upstream `Set-Cookie` is never relayed. SameSite stops a cookie being *sent*, not *set*. |
| OWASP CSRF Cheat Sheet, Fetch Metadata (`Sec-Fetch-Site`, `-Mode`, `-Dest`) | State-changing requests. | Every non-GET through either proxy passes the same-origin `Origin` check. Both proxies refuse cross-site subresource `GET`s. |
| Iron seal (`@hapi/iron` format) | Seal integrity. | The session password is ≥ 32 characters. A tampered or foreign seal reads as no session, never as an error. The session key is the sealed `sid`, or h3's sealed id; neither can be chosen by the attacker. |

### 4.3 The proxies — HTTP semantics, URL parsing, SSRF

| Clause | Requirement in lukk-js | Review checks |
|---|---|---|
| CWE-918 (SSRF) | Fixed targets. | `resolveTarget` keeps the upstream same-origin and under lukk's base path. The app-API proxy has one fixed target and never follows a redirect across origins (`redirect: 'manual'`; RFC 9110 §15.4.8–9: a 307/308 keeps method and body). |
| RFC 3986 §5.2.4, the WHATWG URL Standard | Dot segments and decoding. | The path is judged as the upstream will route it, on every decoding round: `..`, `%2e%2e`, `%2f`, `%5c`, `%25`, `//`. A non-canonical path is refused with 404, never cleaned and then judged. The path/query boundary comes from the raw `node.req.url` (`requestPath`). |
| Symfony `Request::getBaseUrl()` (lukk's router) | Front controllers. | `reachesLukk` refuses lukk's own routes behind any `.php` front controller, including a script in a subdirectory and Symfony's length cut. It is checked against a Symfony routing oracle; any newly allowed path is a finding. |
| RFC 9110 §7.6.1, RFC 9113 §8.2.2 | Hop-by-hop headers. | `Connection`, hop-by-hop headers and the names listed in `Connection` are removed, not blanked. A blanked header is omitted, because HTTP/2 rejects empty connection-specific fields (issue #68). |
| RFC 9110 §7.6.3 | `Via`. | Use a pseudonym, never the internal hostname. |
| RFC 9110 §5.5 | Empty field values. | A header the browser itself sent empty is forwarded as sent. |
| RFC 9110 §9.2.1 | Safe methods. | Refresh is `POST`-only. Nothing that rotates, logs out or revokes is reachable by `GET`. A page render's own requests never rotate (`x-lukk-ssr`). |
| RFC 9110 §15.5.12, §15.5.15 | 411, 414. | The request body is bounded. A path over 8 KiB, measured on the **serialised upstream URL**, gets a 414 before any session read. |
| RFC 9110 §10.2.3 | `Retry-After`. | Use delay-seconds, as a number. |
| CWE-1333 (ReDoS), CWE-400 | Linear time. | Every regex and loop over request input is linear. Test 16–64 KB adversarial inputs: slash runs, `.php` repeats, `%25` chains. |
| WHATWG Fetch `nosniff`, CSP `sandbox` | Responses relayed from the app API. | Relayed app-API responses carry `X-Content-Type-Options: nosniff`, and anything that isn't JSON or PDF is sandboxed. |

### 4.4 Passkeys, from the client side — WebAuthn Level 3

| Clause | Requirement in lukk-js | Review checks |
|---|---|---|
| WebAuthn L3 §5.1, RFC 4648 §5 | Serialising a credential. | `credentialToJSON`, `toCreationOptions` and `toRequestOptions` round-trip base64url without padding. `id`/`rawId` are unchanged. Nothing from the authenticator is trusted client-side; lukk verifies. |
| WebAuthn L3 §4 / NIST SP 800-63B-4 §4.1.2.1 (enforced by lukk) | Step-up level. | The client never decides assurance. It surfaces lukk's `422` on `credential` and its `423`/`409` as they are. |

### 4.5 Session state, SSR and account identity

| Requirement | Review checks |
|---|---|
| A user never sees, or acts as, the wrong account. | A renewal that comes back as another subject rejects with `SESSION_CHANGED`. It doesn't replay the request, and it isn't a sign-out. Step-up state is dropped on account change. A sign-in in another tab is followed. |
| A step-up survives slow responses, but not logout or sign-in. | `confirmationsHeld` is keyed by session and cleared by `forgetRefreshJournal`, a 423, or expiry. It is re-read after the last await before a cookie leaves (`endedOrConfirmationCarried`). |
| SSR hydration. | The SSR payload never carries a secret. Hydration renews before the render when `ssrHydrate: false`. A render's requests never rotate. |
| Every await is a window. | Anything read before an `await` and acted on after it gets re-read, or the window is shown harmless: the session store, `sessionEnded`, the journal head, and the browser gone (`res` closed). |

## 5. lukk-js-specific review checklist

- **Typing.** The client types mirror lukk's responses exactly. A new server field becomes an optional, documented type field, and the conformance key sets are updated in the same change.
- **Public API.** Changes are additive or opt-in. A breaking change needs a changeset, an `UPGRADE.md` entry, and a docs entry.
- **The supported Nuxt range.** `@nuxt/kit ^3.13` is a promise that the `nuxt-floor` CI job keeps. h3 stays on v1 while Nuxt does.
- **Memory.** Every per-process map (journal, held heads, held confirmations, ended sessions) is capped and warns once. Its timers are unref'd and end at a bound.
- **Dependencies.** The published packages' `dependencies` are reviewed as an attack surface. A change in published output is checked with a `dist` diff.

## 6. Deliberate deviations — not findings

| Deviation | Departs from | Why |
|---|---|---|
| The BFF **rotation journal** answers some replays itself (10 min until delivery, then 30 s from delivery). They never reach lukk's reuse signal and can outlast lukk's grace by a request's duration. | RFC 9700 §4.14.2 | Counted from lukk's rotation, a slow request's link expired before its cookie arrived, and the old cookie then replayed into a false logout. |
| The journal, held heads and held confirmations are **per process**. | — | Without sticky sessions the old behaviour returns. This is documented. |
| `.php` paths naming lukk's last base segment are refused, and so is any path naming more than four scripts. | — | That is the price of a linear front-controller check. `/api/oauth/callback.php` with base `/auth` is a known false refusal. |
| A rewrite into a front controller **without** `.php` in the URL is not caught. | — | No path check can see it. It is documented as a limitation. |
| The 2FA challenge token is not held server-side in BFF mode. | — | A recorded trade-off. |
| h3 2 and `@nuxt/module-builder` 1 are held, as are the vitest and TypeScript majors. | — | Nuxt runs on h3 v1. module-builder 1 changes the published types. vitest 5 breaks the Stryker gate. TS 7 has no compiler API. |

## 7. Recurring defect classes (2026-08 → 2026-10 audits)

1. **A fix introduces the inverse defect.** This is the most frequent class. Every patch to a single "hold" object opened a new timing hole, and the journal's delivery model was the fix.
2. **Something read before an await and acted on after it**: a confirmation, the journal head, `sessionEnded`, a closed response.
3. **A listener attached after an await** (`res.once('close')`) on a response that has already closed. It leaks.
4. **A key mismatch**: `sid` versus `sessionKey(...)` for sessions sealed before `sid` existed.
5. **Quadratic regexes and loops over request paths** (trailing `\/+$`, `\/{2,}[^/]`, per-`.php` readings). Each one let a single request block the event loop.
6. **SSR and the browser disagreeing**: header merging, `credentials`, `onRequest` replacement. Check both sides behave identically through real ofetch.
7. **Secrets reaching the payload or `sessionStorage`** through `useState` or Nuxt's reload state.
8. **A conformance key set or type that predates a lukk field.** The exhaustive key-set test fails on the next lukk merge.
9. **Tests that pin nothing**: they pass on the parent commit.
10. **A changeset or UPGRADE entry describing an earlier iteration of a fix.**

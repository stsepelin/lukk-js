# lukk-core

Framework-agnostic client core for **[lukk](https://github.com/stsepelin/lukk)** — the
first-party JWT auth package for Laravel. Powers [`lukk-nuxt`](https://github.com/stsepelin/lukk-js/tree/main/packages/nuxt)
and future framework bindings; usable directly in any TypeScript app.

```bash
npm i lukk-core
```

> **Pre-1.0.** `lukk-core` is `0.x` (versioned in lockstep with `lukk-nuxt`); the public API may change between minor versions per [SemVer §4](https://semver.org/#spec-item-4). Pin an exact version and read the [UPGRADE guide](https://github.com/stsepelin/lukk-js/blob/main/UPGRADE.md) before upgrading.

## What's inside

- **Contract types** mirroring lukk's HTTP API — `TokenPair`, `TwoFactorChallenge`,
  `PasskeyLoginOptions`, … (kept in lockstep with lukk via conformance tests).
- **`createLukkClient(hooks)`** — an auth client that attaches the Bearer token, refreshes
  once on a 401 (concurrent 401s share a single refresh), and exposes a typed method for
  every lukk endpoint.
- **WebAuthn helpers** — `base64url ↔ ArrayBuffer` plus credential (de)serialization for
  `navigator.credentials`.

## Usage

```ts
import { createLukkClient, isTwoFactorChallenge } from 'lukk-core'

let accessToken: string | null = null

const lukk = createLukkClient({
  baseURL: 'https://api.example.com/auth',
  getAccessToken: () => accessToken,
  onTokens: pair => { accessToken = pair.access_token },
  refresh: () => lukk.refreshTokens(), // direct mode: relies on the __Host- refresh cookie
})

const result = await lukk.login({ email, password })
if (isTwoFactorChallenge(result)) {
  // show the 2FA input, then:
  await lukk.twoFactorChallenge({ challenge_token: result.challenge_token, code })
}
```

The hooks are the only thing a binding wires up — *where* tokens live (memory, a sealed
cookie, a server session) is the binding's call; the core just speaks to lukk.

## Security model

- The access token is an **opaque bearer** to the core — it is never decoded or verified
  client-side. All JWT validation (signature, pinned `alg`, `iss`/`aud`/`exp`/`nbf`) is
  lukk's, server-side. The core only carries the token in `Authorization: Bearer …`
  (RFC 6750), never in a URL/query.
- **Credentials are origin-scoped:** the bearer, the `X-Lukk-Confirmation` header, and
  `credentials: 'include'` are attached only to a same-origin-as-`baseURL` target — never
  to an absolute, cross-origin URL.
- **Refresh is single-flighted**, so a burst of 401s never replays a rotated refresh token
  into lukk's reuse detection. See the [Architecture & security model](https://stsepelin.github.io/lukk-docs/architecture).

## Documentation

See [Using lukk-core](https://stsepelin.github.io/lukk-docs/lukk-core) for the
full hook reference, every method, error handling, and the WebAuthn helpers.

## License

MIT

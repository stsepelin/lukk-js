# lukk-core

Framework-agnostic client core for **[lukk](https://github.com/stsepelin/lukk)** — the
first-party JWT auth package for Laravel. Powers [`lukk-nuxt`](https://github.com/stsepelin/lukk-js/tree/main/packages/nuxt)
and future framework bindings; usable directly in any TypeScript app.

```bash
npm i lukk-core
```

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

## Documentation

See [Using lukk-core](https://github.com/stsepelin/lukk-js/blob/main/docs/core.md) for the
full hook reference, every method, error handling, and the WebAuthn helpers.

## License

MIT

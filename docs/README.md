# lukk-js Documentation

JavaScript/TypeScript clients for **[lukk](https://github.com/stsepelin/lukk)** — minimal-dependency JWT authentication for first-party Laravel apps, plus [`useLukkFetch()`](transport-modes.md#use-lukk-fetch), an auth-aware client for your own Laravel API. One composable API across SSR, SPA, and SSG, in either a server-side **BFF** mode or a **direct** browser mode.

> **Unofficial companion to lukk.** Not affiliated with or endorsed by the Laravel or Nuxt teams. "Laravel" and "Nuxt" are referenced only to describe compatibility and design influence.

## Getting Started

- [Introduction](introduction.md) — what lukk-js is, the two packages, and when to use each mode
- [Installation](installation.md) — install the module, configure it, wire your user endpoint
- [Configuration](configuration.md) — every option, explained

## Core

- [Authentication](authentication.md) — login, logout, the reactive user, sessions, and route guards
- [Transport Modes](transport-modes.md) — BFF vs direct: security, performance, and the SSR/SPA/SSG matrix
- [Using lukk-core](core.md) — the framework-agnostic client, for non-Nuxt apps

## Additional Features

- [Two-Factor Authentication](two-factor-authentication.md) — the login challenge and 2FA management
- [Passkeys](passkeys.md) — register, passwordless login, and management
- [Confirmation](confirmation.md) — step-up ("sudo") confirmation for sensitive actions

## Reference

- [Architecture](architecture.md) — design rationale, the hooks seam, the mode switch, and conformance

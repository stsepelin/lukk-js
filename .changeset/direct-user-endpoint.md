---
"lukk-nuxt": patch
---

**Direct mode: fixes a regression that stopped the user ever loading when the lukk base URL is absolute.**

Unreleased, but worth naming because nothing in the test suite could see it. `loadUser` asks for the configured `user.endpoint` with `baseURL: ''` — ofetch's idiom for "take this path exactly as given". The new per-call origin check read that empty base as a *relative* one and refused it against an absolute API base, so on any direct-mode app configured the way the docs show (`baseURL: 'https://api.example.com/auth'`), sign-in succeeded and the user then never loaded: no bearer, a `401`, a refresh-token rotation spent on the retry, another `401`, and the route middleware bouncing the visitor back to `/login`.

An empty per-call base is now treated as absent. The conformance suite builds one of its two direct modes against an absolute lukk base for this reason — every direct topology it ran before was relative, which is the one shape the bug could not reach.

Also narrowed: this app's own origin stands in for the API's only where the API base is the relative BFF proxy mount, which is the case that needs it (`isSameOrigin` refuses every absolute URL against a relative base). With an absolute API base the app's origin is a different host that the bearer was never scoped to — and during SSR it comes from the `Host` header.

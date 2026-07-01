---
layout: home

hero:
  name: lukk-js
  text: Laravel JWT auth for Nuxt
  tagline: First-party authentication — plus an auth-aware fetch and reactive forms for your own Laravel API. SSR / SPA / SSG, in BFF or direct mode, one composable API either way.
  actions:
    - theme: brand
      text: Get Started
      link: /introduction
    - theme: alt
      text: Configuration
      link: /configuration
    - theme: alt
      text: GitHub
      link: https://github.com/stsepelin/lukk-js

features:
  - title: One composable API, every mode
    details: The same useLukkAuth / useLukkFetch / useLukkForm work in SSR, SPA, and SSG — a config switch flips between the secure BFF proxy and direct browser mode. Your app code never changes.
  - title: Auth-aware fetch & forms
    details: useLukkFetch authenticates your own Laravel API in every context (a plain $fetch silently 401s in SSR); useLukkForm binds a 422 bag to per-field errors, Inertia-useForm-style.
  - title: Secure by default
    details: In BFF mode the browser holds no token — a sealed __Host- session, origin-scoped credentials, and CSRF + SSRF guards on both proxies.
  - title: Tiny & typed
    details: lukk-core has zero runtime dependencies; the lukk HTTP contract is mirrored in TypeScript and conformance-tested against a real lukk instance so it can't drift.
---

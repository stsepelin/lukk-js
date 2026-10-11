// Type-only fixture, checked by `nuxi typecheck playground`: the documented configurations must type-check.
// Nuxt types a module's options as a SHALLOW Partial, so a nested field the defaults fill (`api.forceJson`,
// `session.password` from the env) failed the build of an app that wrote only what the docs show.
import type { NuxtConfig } from 'nuxt/schema'

export const documentedApiProxy: NuxtConfig['lukk'] = { mode: 'bff', baseURL: 'https://api.example.com/auth', api: { path: '/api', target: 'https://api.example.com' } }
export const documentedSessionName: NuxtConfig['lukk'] = { mode: 'bff', baseURL: 'https://api.example.com/auth', session: { name: 'my-app' } }
export const documentedUserKey: NuxtConfig['lukk'] = { user: { key: false } }

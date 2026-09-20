/** A lightweight stand-in for Nuxt's `#imports`, so runtime code can be unit-
 *  tested without booting Nuxt. Configure per-test via the `__test` handle. */
import { computed, reactive, ref, shallowRef, toRaw, watch, type Ref } from 'vue'

const states = new Map<string, Ref<unknown>>()

export const __test = {
  nuxtApp: {} as Record<string, unknown>,
  runtimeConfig: { public: { lukk: {} as Record<string, unknown> } },
  navigated: undefined as unknown,
  navigatedOptions: undefined as unknown,
  requestHeaders: {} as Record<string, string | undefined>,
  requestURL: undefined as string | undefined,
  storageMounts: new Set<string>(),
  reset() {
    states.clear()
    this.nuxtApp = {}
    this.runtimeConfig = { public: { lukk: {} } }
    this.navigated = undefined
    this.navigatedOptions = undefined
    this.requestHeaders = {}
    this.requestURL = undefined
    this.storageMounts = new Set()
  },
}

/** Every `useState` key written so far — what Nuxt would serialize into the SSR payload. */
export function ssrPayload(): Record<string, unknown> {
  return Object.fromEntries([...states].map(([key, value]) => [key, toRaw(value.value)]))
}

export function useState<T>(key: string, init: () => T): Ref<T> {
  if (!states.has(key)) states.set(key, ref(init()) as Ref<unknown>)
  return states.get(key) as Ref<T>
}
export const useNuxtApp = () => __test.nuxtApp
export const useRuntimeConfig = () => __test.runtimeConfig
export const navigateTo = (to: unknown, options?: unknown) => { __test.navigated = to; __test.navigatedOptions = options; return to }
// Filters by the requested names, like Nuxt's own: a mock that returned every header let a request for
// the wrong one pass unnoticed.
export const useRequestHeaders = (keys?: string[]) => keys
  ? Object.fromEntries(Object.entries(__test.requestHeaders).filter(([name]) => keys.includes(name)))
  : __test.requestHeaders
export const useRequestURL = () => new URL(__test.requestURL ?? 'https://app.test/')
// Only needs to resolve for the import; the server-BFF branch that calls it is
// unreachable in the client test env (it's driven via createRequestFetch's own test).
export const useRequestFetch = () => (async () => undefined) as unknown
// Accepts a function plugin or the object form `{ name, dependsOn, setup }`; tests invoke the
// returned setup directly. The object form's metadata rides along on `.meta`: consumers are told to
// `dependsOn` a plugin by NAME, and Nuxt silently ignores a name that matches nothing — so a rename
// has to fail a test, not reintroduce a startup deadlock.
export const defineNuxtPlugin = (plugin: unknown): unknown => {
  if (typeof plugin === 'function') return plugin
  const { setup, ...meta } = plugin as { setup: (...args: unknown[]) => unknown }
  return Object.assign((...args: unknown[]) => setup(...args), { meta })
}
export const defineNuxtRouteMiddleware = <T>(fn: T): T => fn
export const defineNitroPlugin = <T>(fn: T): T => fn
// A Nitro storage mount stand-in: an in-memory key/value map per mount name.
const storages = new Map<string, Map<string, unknown>>()
export const useStorage = (mount = '') => {
  const items = storages.get(mount) ?? storages.set(mount, new Map()).get(mount)!
  return {
    setItem: async (key: string, value: unknown, _options?: unknown) => { items.set(key, value) },
    getItem: async (key: string) => (items.has(key) ? items.get(key) : null),
    // Nitro's root storage answers `base: ''` for a key under no mount; the test declares its mounts.
    getMount: (key: string) => ({ base: __test.storageMounts.has(key.replace(/:$/, '')) ? key : '' }),
  }
}
export { computed, reactive, ref, shallowRef, toRaw, watch }

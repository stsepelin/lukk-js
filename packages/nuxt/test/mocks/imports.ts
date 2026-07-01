/** A lightweight stand-in for Nuxt's `#imports`, so runtime code can be unit-
 *  tested without booting Nuxt. Configure per-test via the `__test` handle. */
import { computed, ref, type Ref } from 'vue'

const states = new Map<string, Ref<unknown>>()

export const __test = {
  nuxtApp: {} as Record<string, unknown>,
  runtimeConfig: { public: { lukk: {} as Record<string, unknown> } },
  navigated: undefined as unknown,
  navigatedOptions: undefined as unknown,
  requestHeaders: {} as Record<string, string | undefined>,
  reset() {
    states.clear()
    this.nuxtApp = {}
    this.runtimeConfig = { public: { lukk: {} } }
    this.navigated = undefined
    this.navigatedOptions = undefined
    this.requestHeaders = {}
  },
}

export function useState<T>(key: string, init: () => T): Ref<T> {
  if (!states.has(key)) states.set(key, ref(init()) as Ref<unknown>)
  return states.get(key) as Ref<T>
}
export const useNuxtApp = () => __test.nuxtApp
export const useRuntimeConfig = () => __test.runtimeConfig
export const navigateTo = (to: unknown, options?: unknown) => { __test.navigated = to; __test.navigatedOptions = options; return to }
export const useRequestHeaders = (_keys?: string[]) => __test.requestHeaders
// Only needs to resolve for the import; the server-BFF branch that calls it is
// unreachable in the client test env (it's driven via createRequestFetch's own test).
export const useRequestFetch = () => (async () => undefined) as unknown
export const defineNuxtPlugin = <T>(fn: T): T => fn
export const defineNuxtRouteMiddleware = <T>(fn: T): T => fn
export { computed }

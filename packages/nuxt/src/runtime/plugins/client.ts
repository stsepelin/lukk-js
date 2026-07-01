import { createLukkClient, type LukkClient, singleFlight } from 'lukk-core'
// #imports is resolved by Nuxt at build time
import { defineNuxtPlugin, useRuntimeConfig, useState } from '#imports'
import { ACCESS_KEY, CONFIRMATION_KEY } from '../keys'
import { LUKK_BFF_PREFIX } from '../shared'

/**
 * Provides `$lukk` — the core client, wired for the configured transport.
 *  - direct: hits lukk directly (refresh via the `__Host-refresh` cookie).
 *  - bff:    hits our same-origin Nitro proxy (which holds the tokens).
 */
export default defineNuxtPlugin(() => {
  const cfg = useRuntimeConfig().public.lukk as {
    mode: 'bff' | 'direct'
    baseURL: string
    confirmationHeader: string
  }

  const baseURL = cfg.mode === 'direct' ? cfg.baseURL : LUKK_BFF_PREFIX

  // Access-token holder. Written ONLY on the client (guarded below) so it never
  // lands in the serialized SSR payload — in BFF mode it stays null (the proxy
  // holds the token); in direct mode it lives in client memory only.
  const accessToken = useState<string | null>(ACCESS_KEY, () => null)
  const confirmation = useState<string | null>(CONFIRMATION_KEY, () => null)

  // ONE single-flight refresh, shared by `$lukk`'s own 401 path AND `useLukkFetch`'s
  // app-API retry — so a concurrent auth + app-API 401 can't replay the rotating
  // refresh token twice (which reuse detection would punish with a family revoke).
  // The closures reference `client`, which only runs after assignment, so const is safe.
  const refresh = singleFlight(async () => {
    const pair = await client.refreshTokens()
    if (import.meta.client) accessToken.value = pair.access_token
    return pair
  })
  // A throwing refresh means "not refreshable" → null (the documented contract).
  const safeRefresh = () => refresh().catch(() => null)

  const client: LukkClient = createLukkClient({
    baseURL,
    confirmationHeader: cfg.confirmationHeader,
    getAccessToken: () => accessToken.value,
    getConfirmationToken: () => confirmation.value,
    refresh: safeRefresh,
    onTokens: (pair) => { if (import.meta.client) accessToken.value = pair.access_token },
    onUnauthenticated: () => { accessToken.value = null },
  })

  return { provide: { lukk: client, lukkRefresh: safeRefresh } }
})

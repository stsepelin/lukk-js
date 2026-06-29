import { createLukkClient, type LukkClient } from 'lukk-core'
// #imports is resolved by Nuxt at build time
import { defineNuxtPlugin, useRuntimeConfig, useState } from '#imports'
import { ACCESS_KEY, CONFIRMATION_KEY } from '../keys'

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

  const baseURL = cfg.mode === 'direct' ? cfg.baseURL : '/api/_lukk'

  // Access-token holder. Written ONLY on the client (guarded below) so it never
  // lands in the serialized SSR payload — in BFF mode it stays null (the proxy
  // holds the token); in direct mode it lives in client memory only.
  const accessToken = useState<string | null>(ACCESS_KEY, () => null)
  const confirmation = useState<string | null>(CONFIRMATION_KEY, () => null)

  // `refresh` self-references `client`; the closure only runs after assignment, so const is safe.
  const client: LukkClient = createLukkClient({
    baseURL,
    confirmationHeader: cfg.confirmationHeader,
    getAccessToken: () => accessToken.value,
    getConfirmationToken: () => confirmation.value,
    refresh: () => client.refreshTokens().catch(() => null),
    onTokens: (pair) => { if (import.meta.client) accessToken.value = pair.access_token },
    onUnauthenticated: () => { accessToken.value = null },
  })

  return { provide: { lukk: client } }
})

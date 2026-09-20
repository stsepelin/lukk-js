import { useSharedEndedSessions } from '../ended-sessions'
import { defineNitroPlugin, useRuntimeConfig, useStorage } from '#imports'

/**
 * Wire `session.sharedStore` — a Nitro storage mount — into the replaced-session record, so every server
 * instance sees a session another instance ended. Registered in BFF mode; a no-op unless the option is set.
 *
 * Each entry carries its own expiry as its value, so a driver without native TTL still answers correctly;
 * `ttl` is passed for drivers that expire keys themselves (Redis, Upstash / Vercel KV). Use one of those:
 * on a driver without TTL, entries are never deleted. Not an eventually consistent store (Cloudflare KV
 * can take up to a minute to show a write elsewhere) — the window this record guards is under a second.
 */
export default defineNitroPlugin(() => {
  const mount = (useRuntimeConfig().lukk as { sharedStore?: string } | undefined)?.sharedStore
  if (!mount) return

  // A name that matches no mount silently falls back to Nitro's in-memory root storage — "shared" in name
  // only, per process in fact. Say so at startup.
  if (!useStorage().getMount(`${mount}:`).base) {
    console.warn(`[lukk-nuxt] session.sharedStore "${mount}" is not a configured \`nitro.storage\` mount; the replaced-session record will not be shared between server instances.`)
  }

  const storage = useStorage(mount)
  useSharedEndedSessions({
    mark: (key, ttlMs) => storage.setItem(`ended:${key}`, Date.now() + ttlMs, { ttl: Math.ceil(ttlMs / 1000) }),
    has: async (key) => {
      const expires = await storage.getItem(`ended:${key}`)
      return typeof expires === 'number' && expires > Date.now()
    },
  })
})

import { createLukkClient, type LukkClient, singleFlight, type TokenPair } from 'lukk-core'
import { defineNuxtPlugin, useNuxtApp, useRuntimeConfig, useState } from '#imports'
import { useLukkAuth } from '../composables/useLukkAuth'
import { ACCESS_KEY, CONFIRMATION_KEY } from '../keys'
import { confirmationHeaderName, isAuthRejection, LUKK_BFF_PREFIX } from '../shared'
import { restoreState, settle } from '../utils/restore-state'

/**
 * A refresh that finished after the session it belonged to had ended or been replaced. Thrown, not
 * returned, so every consumer's existing "the refresh failed" path handles it.
 */
class SupersededRefresh extends Error {}

/**
 * Provides `$lukk` — the core client, wired for the configured transport.
 *  - direct: hits lukk directly (refresh via the `__Host-refresh` cookie).
 *  - bff:    hits our same-origin Nitro proxy (which holds the tokens).
 *
 * Named (`lukk:client`) so the session-restore plugin can `dependsOn` it — the
 * `$lukk` / `$lukkRefresh` provide is then guaranteed in effect before anything
 * consumes it, even under parallel plugins or layers.
 */
export default defineNuxtPlugin({
  name: 'lukk:client',
  setup() {
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
    //
    // Each flight records the session generation it started in, and drops its pair when a `logout()` or
    // a sign-in has moved on by the time it lands. Checked HERE, where the token is written, rather than
    // only by the restore: a restore joins a flight that may have started before the logout it is
    // racing, and the write already happened by the time the restore saw the result.
    const state = restoreState(useNuxtApp())
    let flightEpoch = state.epoch

    const flight = singleFlight(async () => {
      const epoch = flightEpoch = state.epoch

      try {
        // A sign-in or logout on the wire is replacing or ending the session this refresh would renew.
        // Sending now would rotate the OLD cookie and could set it back afterwards — so wait. A sign-in
        // that started a new session means never sending at all; after a logout, the refresh goes out
        // with the cleared cookie and is simply rejected.
        if (state.handover) {
          await settle(state.handover)
          if (epoch !== state.epoch) throw new SupersededRefresh('lukk: a sign-in replaced the session before this refresh was sent')
        }

        const pair = await client.refreshTokens()
        if (epoch !== state.epoch) throw new SupersededRefresh('lukk: the session changed while this refresh was in flight')
        if (import.meta.client) accessToken.value = pair.access_token
        return pair
      }
      finally {
        state.refreshing = null
      }
    })
    // Published so a sign-in or `logout()` can wait for it — see `settleRefresh`.
    const refresh = (): Promise<TokenPair> => (state.refreshing = flight())
    // Abilities are re-derived on EVERY mint server-side — that is what makes revoking one take
    // effect within `access_ttl` rather than lasting the life of the refresh token. The client only
    // learns a grant through the user resource, so without this a refreshed token silently carried a
    // new grant while the UI kept rendering from the old one: a control stayed visible until it
    // 403'd, or a newly-granted one stayed hidden, until something else happened to reload the user.
    //
    // Only fires when the loaded user actually carries `abilities` — an app that doesn't use the
    // feature pays nothing — and only on the client, since a server render reloads the user itself
    // (`plugins/session.server.ts`). Fire-and-forget: a UI hint must not delay the request that
    // triggered the refresh.
    let resyncing = false

    async function resyncAbilities(): Promise<void> {
      const { user, fetchUser } = useLukkAuth()

      // `resyncing` breaks the cycle where `fetchUser`'s own 401 refreshes again and re-enters here.
      if (resyncing || user.value?.abilities === undefined) return

      resyncing = true
      try { await fetchUser() }
      finally { resyncing = false }
    }

    // A throwing refresh means "not refreshable" → null (the documented contract).
    const safeRefresh = () => refresh()
      .then((pair) => {
        if (import.meta.client) void resyncAbilities().catch(() => {})
        return pair
      })
      .catch(() => null)

    const client: LukkClient = createLukkClient({
      baseURL,
      // Through the same runtime fallback both proxies use. This is PUBLIC runtime config, so
      // `NUXT_PUBLIC_LUKK_CONFIRMATION_HEADER` lands after the build and defeats the module's
      // validation: `authorization` would clobber the bearer with the step-up token on every
      // confirmed request, and an empty value would make `Headers.set` throw on all of them.
      confirmationHeader: confirmationHeaderName(cfg.confirmationHeader),
      getAccessToken: () => accessToken.value,
      getConfirmationToken: () => confirmation.value,
      refresh: safeRefresh,
      onTokens: (pair) => { if (import.meta.client) accessToken.value = pair.access_token },
      // Not when the refresh that failed was superseded: the token held now belongs to a session that
      // began after that refresh started, and it is not the one the server rejected.
      onUnauthenticated: () => { if (flightEpoch === state.epoch) accessToken.value = null },
    })

    // The SAME single-flight as `safeRefresh`, so a boot restore still can't replay the rotating
    // refresh token alongside a concurrent 401 retry — but it keeps WHY a refresh failed. `safeRefresh`
    // reduces every failure to null, which is right for a request retry and wrong for the restore: a
    // 401 means "no session", while a 429, a 5xx or an unreachable server means "couldn't tell", and
    // reporting the second as signed-out prompts a signed-in user to log in again.
    const restore = (): Promise<{ pair: TokenPair | null, unavailable: boolean }> => refresh().then(
      pair => ({ pair, unavailable: false }),
      // Superseded is an answer, not a failure: a newer `logout()` or sign-in decided the session.
      (error: unknown) => ({ pair: null, unavailable: !(error instanceof SupersededRefresh) && !isAuthRejection(error) }),
    )

    return { provide: { lukk: client, lukkRefresh: safeRefresh, lukkRestore: restore } }
  },
})

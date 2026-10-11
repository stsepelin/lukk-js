/**
 * Type-level assertions on the client's PUBLIC surface. Never executed — `types.test.ts` type-checks this
 * file, since vitest strips types and `tsc` here only covers `src/`.
 */
import { expectTypeOf } from 'vitest'
import { type AccountExport, createLukkClient, type LukkStatus, type PasskeySummary } from '../src'

const client = createLukkClient({ baseURL: 'https://x/auth' })

// lukk answers these four with `{"status": "..."}` JSON, not an empty body.
expectTypeOf(client.forgotPassword).returns.toEqualTypeOf<Promise<LukkStatus>>()
expectTypeOf(client.resetPassword).returns.toEqualTypeOf<Promise<LukkStatus>>()
expectTypeOf(client.changePassword).returns.toEqualTypeOf<Promise<LukkStatus>>()
expectTypeOf(client.sendEmailVerification).returns.toEqualTypeOf<Promise<LukkStatus>>()
expectTypeOf<LukkStatus>().toEqualTypeOf<{ status: string }>()

// Logout can present the refresh token.
expectTypeOf(client.logout).parameter(0).toEqualTypeOf<{ retry?: boolean, refreshToken?: string } | undefined>()

// The export states every passkey field erasure destroys, its times as ISO-8601 strings like the rest of
// the file — `last_used_at` was unix seconds there up to lukk 0.6.0, which sent none of the three new fields
// (optional, for it). `GET /auth/passkeys` keeps its own shape, unix seconds included.
expectTypeOf<AccountExport['passkeys'][number]>().toEqualTypeOf<{
  credential_id: string
  name: string | null
  created_at?: string | null
  last_used_at: string | null
  aaguid?: string | null
  transports?: string[] | null
}>()
expectTypeOf<PasskeySummary>().toEqualTypeOf<{ id: string, name: string | null, last_used_at: number | null }>()

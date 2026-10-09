/**
 * Type-level assertions on the client's PUBLIC surface. Never executed — `types.test.ts` type-checks this
 * file, since vitest strips types and `tsc` here only covers `src/`.
 */
import { expectTypeOf } from 'vitest'
import { createLukkClient, type LukkStatus } from '../src'

const client = createLukkClient({ baseURL: 'https://x/auth' })

// lukk answers these four with `{"status": "..."}` JSON, not an empty body.
expectTypeOf(client.forgotPassword).returns.toEqualTypeOf<Promise<LukkStatus>>()
expectTypeOf(client.resetPassword).returns.toEqualTypeOf<Promise<LukkStatus>>()
expectTypeOf(client.changePassword).returns.toEqualTypeOf<Promise<LukkStatus>>()
expectTypeOf(client.sendEmailVerification).returns.toEqualTypeOf<Promise<LukkStatus>>()
expectTypeOf<LukkStatus>().toEqualTypeOf<{ status: string }>()

// Logout can present the refresh token.
expectTypeOf(client.logout).parameter(0).toEqualTypeOf<{ retry?: boolean, refreshToken?: string } | undefined>()

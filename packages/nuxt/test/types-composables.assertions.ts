/**
 * Type-level assertions on the composables' PUBLIC surface. Never executed — `types-composables.test.ts`
 * type-checks this file with `#imports` left unresolvable, the condition the module build publishes
 * declarations under. An inferred member degrades to `any` there, which fails an `expectTypeOf` below
 * or leaves a `@ts-expect-error` unused.
 */
import { type AccountExport, type ChangePasswordInput, isRegistrationPending, isTwoFactorChallenge, type LoginInput, type LoginResult, type LukkUser, type PasskeySummary, type RecoveryCodeCount, type RegisterInput, type RegisterResult, type ResetPasswordInput, type TwoFactorEnrollment, type LukkClient, type RegistrationPending, type TwoFactorChallenge } from 'lukk-core'
import type { $Fetch } from 'ofetch'
import type { LukkBffClient } from '../src/runtime/shared'
import { expectTypeOf } from 'vitest'
import type { ComputedRef, Ref } from 'vue'
import { useLukkAbilities } from '../src/runtime/composables/useLukkAbilities'
import { useLukkAccount } from '../src/runtime/composables/useLukkAccount'
import { type BffSignInResult, useLukkAuth } from '../src/runtime/composables/useLukkAuth'
import { useLukkChangePassword } from '../src/runtime/composables/useLukkChangePassword'
import { useLukkConfirmation } from '../src/runtime/composables/useLukkConfirmation'
import { useLukkEmailVerification } from '../src/runtime/composables/useLukkEmailVerification'
import { useLukkFetch } from '../src/runtime/composables/useLukkFetch'
import { useLukkForm } from '../src/runtime/composables/useLukkForm'
import { useLukkPasskeys } from '../src/runtime/composables/useLukkPasskeys'
import { useLukkPasswordReset } from '../src/runtime/composables/useLukkPasswordReset'
import { useLukkTwoFactor } from '../src/runtime/composables/useLukkTwoFactor'

// --- useLukkAbilities -------------------------------------------------------------------------------
const abilities = useLukkAbilities()
expectTypeOf(abilities.abilities).toEqualTypeOf<ComputedRef<string[] | undefined>>()
expectTypeOf(abilities.enforced).toEqualTypeOf<ComputedRef<boolean>>()
expectTypeOf(abilities.pinned).toEqualTypeOf<ComputedRef<boolean>>()
expectTypeOf(abilities.canManageSessions).toEqualTypeOf<ComputedRef<boolean>>()
expectTypeOf(abilities.canManageAccount).toEqualTypeOf<ComputedRef<boolean>>()
expectTypeOf(abilities.canDeleteAccount).toEqualTypeOf<ComputedRef<boolean>>()
expectTypeOf(abilities.can).toEqualTypeOf<(ability: string) => boolean>()
expectTypeOf(abilities.cannot).toEqualTypeOf<(ability: string) => boolean>()
expectTypeOf(abilities.canAny).toEqualTypeOf<(list: string[]) => boolean>()
expectTypeOf(abilities.canAll).toEqualTypeOf<(list: string[]) => boolean>()
// @ts-expect-error derived from the loaded user — not assignable
abilities.enforced.value = false

// --- useLukkAccount ---------------------------------------------------------------------------------
const account = useLukkAccount()
expectTypeOf(account.user).toEqualTypeOf<Ref<LukkUser | null>>()
expectTypeOf(account.busy).toEqualTypeOf<ComputedRef<boolean>>()
expectTypeOf(account.deleteAccount).toEqualTypeOf<() => Promise<void>>()
expectTypeOf(account.exportAccount).toEqualTypeOf<() => Promise<AccountExport>>()
// @ts-expect-error the in-flight count owns it
account.busy.value = false

// --- useLukkChangePassword --------------------------------------------------------------------------
const changePassword = useLukkChangePassword()
expectTypeOf(changePassword.changing.value).toEqualTypeOf<boolean>()
expectTypeOf(changePassword.changePassword).toEqualTypeOf<(input: ChangePasswordInput) => Promise<void>>()
// @ts-expect-error the in-flight guard owns it
changePassword.changing.value = false

// --- useLukkConfirmation ----------------------------------------------------------------------------
const confirmation = useLukkConfirmation()
expectTypeOf(confirmation.confirmed).toEqualTypeOf<ComputedRef<boolean>>()
expectTypeOf(confirmation.required.value).toEqualTypeOf<boolean>()
expectTypeOf(confirmation.token.value).toEqualTypeOf<string | null>()
expectTypeOf(confirmation.confirmPassword).toEqualTypeOf<(password: string) => Promise<void>>()
expectTypeOf(confirmation.clear).toEqualTypeOf<() => void>()
expectTypeOf(confirmation.cancel).toEqualTypeOf<() => void>()
expectTypeOf(confirmation.withConfirmation(async () => 42)).toEqualTypeOf<Promise<number>>()
// @ts-expect-error only `record()` flips it
confirmation.confirmed.value = true
// @ts-expect-error `cancel()` drops it
confirmation.required.value = false
// @ts-expect-error `record()` / `clear()` own the token
confirmation.token.value = 'forged'

// --- useLukkEmailVerification -----------------------------------------------------------------------
const emailVerification = useLukkEmailVerification()
expectTypeOf(emailVerification.verified).toEqualTypeOf<ComputedRef<boolean>>()
expectTypeOf(emailVerification.sending.value).toEqualTypeOf<boolean>()
expectTypeOf(emailVerification.sendVerificationEmail).toEqualTypeOf<() => Promise<void>>()
expectTypeOf(emailVerification.syncAfterVerify).toEqualTypeOf<() => Promise<void>>()
// @ts-expect-error derived from the loaded user
emailVerification.verified.value = true
// @ts-expect-error the request owns it
emailVerification.sending.value = true

// --- useLukkFetch -----------------------------------------------------------------------------------
expectTypeOf(useLukkFetch()).toEqualTypeOf<$Fetch>()

// --- useLukkForm (generic) --------------------------------------------------------------------------
const form = useLukkForm({ email: '', remember: false })
expectTypeOf(form.data).toEqualTypeOf<{ email: string, remember: boolean }>()
expectTypeOf(form.errors.email).toEqualTypeOf<string | undefined>()
expectTypeOf(form.processing).toEqualTypeOf<boolean>()
expectTypeOf(form.isDirty).toEqualTypeOf<boolean>()
expectTypeOf(form.post<{ id: number }>('/orders')).toEqualTypeOf<Promise<{ id: number }>>()
expectTypeOf(form.reset('email')).toEqualTypeOf(form)
form.data.email = 'fields stay editable'
// @ts-expect-error not a field of this form
form.errors.password = 'x'
// @ts-expect-error not a field of this form
form.reset('password')
// @ts-expect-error the submit owns it
form.processing = true
// @ts-expect-error a computed, not writable
form.isDirty = false
// @ts-expect-error replacing `data` would detach it from what `submit` sends
form.data = { email: '', remember: true }

// --- useLukkPasskeys --------------------------------------------------------------------------------
const passkeys = useLukkPasskeys()
expectTypeOf(passkeys.register).toEqualTypeOf<(name?: string) => Promise<void>>()
expectTypeOf(passkeys.login).toEqualTypeOf<() => Promise<LoginResult | BffSignInResult>>()
expectTypeOf(passkeys.confirm).toEqualTypeOf<() => Promise<void>>()
expectTypeOf(passkeys.list).toEqualTypeOf<() => Promise<{ passkeys: PasskeySummary[] }>>()
expectTypeOf(passkeys.remove).toEqualTypeOf<(id: string) => Promise<void>>()

// --- useLukkPasswordReset ---------------------------------------------------------------------------
const passwordReset = useLukkPasswordReset()
expectTypeOf(passwordReset.sending.value).toEqualTypeOf<boolean>()
expectTypeOf(passwordReset.resetting.value).toEqualTypeOf<boolean>()
expectTypeOf(passwordReset.sendResetLink).toEqualTypeOf<(email: string) => Promise<void>>()
expectTypeOf(passwordReset.reset).toEqualTypeOf<(input: ResetPasswordInput) => Promise<void>>()
// @ts-expect-error the request owns it
passwordReset.sending.value = true
// @ts-expect-error the request owns it
passwordReset.resetting.value = true

// --- useLukkTwoFactor -------------------------------------------------------------------------------
const twoFactor = useLukkTwoFactor()
expectTypeOf(twoFactor.enable).toEqualTypeOf<() => Promise<TwoFactorEnrollment>>()
expectTypeOf(twoFactor.confirm).toEqualTypeOf<(code: string) => Promise<void>>()
expectTypeOf(twoFactor.disable).toEqualTypeOf<() => Promise<void>>()
expectTypeOf(twoFactor.recoveryCodeCount).toEqualTypeOf<() => Promise<RecoveryCodeCount>>()
expectTypeOf(twoFactor.regenerateRecoveryCodes).toEqualTypeOf<() => Promise<{ recovery_codes: string[] }>>()

// --- useLukkAuth ------------------------------------------------------------------------------------
// The one this file was written for, and the one it omitted: the largest surface here, whose own source
// comment names the regression (published declarations typing members `any`). Dropping its `: LukkAuth`
// return annotation left every assertion in this file green.
const auth = useLukkAuth()
expectTypeOf(auth.user).toEqualTypeOf<Ref<LukkUser | null>>()
expectTypeOf(auth.loggedIn).toEqualTypeOf<ComputedRef<boolean>>()
expectTypeOf(auth.ready).toEqualTypeOf<ComputedRef<boolean>>()
expectTypeOf(auth.whenReady).toEqualTypeOf<() => Promise<void>>()
expectTypeOf(auth.restoreFailed).toEqualTypeOf<ComputedRef<boolean>>()
expectTypeOf(auth.pendingTwoFactor).toEqualTypeOf<ComputedRef<boolean>>()
expectTypeOf(auth.register).toEqualTypeOf<(input: RegisterInput) => Promise<RegisterResult | BffSignInResult>>()
expectTypeOf(auth.login).toEqualTypeOf<(credentials: LoginInput) => Promise<LoginResult | BffSignInResult>>()
// In BFF mode a sign-in resolves to the proxy's `{ ok, expires_in }` — no token reaches the browser — so
// `access_token` is not something the result can be assumed to have.
declare const signedIn: Awaited<ReturnType<typeof auth.login>>
// @ts-expect-error — narrow first (`'access_token' in result`): in BFF mode there is none
void signedIn.access_token
expectTypeOf(auth.verifyTwoFactor).toEqualTypeOf<(code: string) => Promise<void>>()
expectTypeOf(auth.verifyRecoveryCode).toEqualTypeOf<(recoveryCode: string) => Promise<void>>()
expectTypeOf(auth.logout).toEqualTypeOf<() => Promise<void>>()
expectTypeOf(auth.revokeOtherSessions).toEqualTypeOf<() => Promise<void>>()
expectTypeOf(auth.fetchUser).toEqualTypeOf<() => Promise<void>>()
expectTypeOf(auth.initSession).toEqualTypeOf<() => Promise<void>>()
// @ts-expect-error the restore owns it
auth.loggedIn.value = true

// --- lukk-core's guards on the composables' results ------------------------------------------------------
// `isTwoFactorChallenge(await login(...))` is what UPGRADE.md recommends, and the composables resolve the
// BFF shape too: guards typed for lukk-core's own result alone rejected them (TS2345).
declare const loginOutcome: Awaited<ReturnType<ReturnType<typeof useLukkAuth>['login']>>
if (isTwoFactorChallenge(loginOutcome)) expectTypeOf(loginOutcome.challenge_token).toEqualTypeOf<string>()
declare const registered: Awaited<ReturnType<ReturnType<typeof useLukkAuth>['register']>>
if (isRegistrationPending(registered)) expectTypeOf(registered.registered).toEqualTypeOf<true>()

// --- `$lukk` in bff mode ---------------------------------------------------------------------------------------
// The proxy answers a sign-in or renewal with its acknowledgement, and a step-up without its token.
declare const bff: LukkBffClient
expectTypeOf(bff.login).returns.toEqualTypeOf<Promise<TwoFactorChallenge | BffSignInResult>>()
expectTypeOf(bff.loginWithPasskey).returns.toEqualTypeOf<Promise<TwoFactorChallenge | BffSignInResult>>()
expectTypeOf(bff.register).returns.toEqualTypeOf<Promise<RegistrationPending | TwoFactorChallenge | BffSignInResult>>()
expectTypeOf(bff.twoFactorChallenge).returns.toEqualTypeOf<Promise<BffSignInResult>>()
expectTypeOf(bff.refreshTokens).returns.toEqualTypeOf<Promise<BffSignInResult>>()
expectTypeOf(bff.confirmPassword).returns.toEqualTypeOf<Promise<{ ok: true }>>()
expectTypeOf(bff.confirmPasskey).returns.toEqualTypeOf<Promise<{ ok: true }>>()
expectTypeOf(bff.logout).toEqualTypeOf<LukkClient['logout']>() // the rest as lukk-core types them

// --- useLukkForm, nested data -----------------------------------------------------------------------------
// Laravel reports a nested field under its dotted key (`authorization.role`), and `nestedErrors` expands
// those: `errors['authorization.role']` was TS2551, `nestedErrors.authorization?.role` an error on `unknown`.
const nested = useLukkForm({ name: '', authorization: { role: '' }, items: [{ name: '' }], tags: [''] })
expectTypeOf(nested.errors['authorization.role']).toEqualTypeOf<string | undefined>()
expectTypeOf(nested.errors['items.0.name']).toEqualTypeOf<string | undefined>()
expectTypeOf(nested.errors.name).toEqualTypeOf<string | undefined>()
expectTypeOf(nested.nestedErrors.name).toEqualTypeOf<string | undefined>()
expectTypeOf(nested.nestedErrors.authorization?.role).toEqualTypeOf<string | undefined>()
expectTypeOf(nested.nestedErrors.items?.[0]?.name).toEqualTypeOf<string | undefined>()
expectTypeOf(nested.nestedErrors.tags?.[0]).toEqualTypeOf<string | undefined>()
nested.setError('authorization.role', 'Pick a role.')
// @ts-expect-error a key with no dot is a field of the form, and this one is not
nested.errors.role = 'x'

import type { FetchOptions } from 'ofetch'
import type { LukkError } from 'lukk-core'
import { computed, reactive, ref, shallowRef } from '#imports'
import { useLukkFetch } from './useLukkFetch'

type FormFields = Record<string, unknown>
/** First validation message per field (Laravel returns an array; we surface [0]). */
type FormErrors<T> = Partial<Record<keyof T, string>>
type FormMethod = 'get' | 'post' | 'put' | 'patch' | 'delete'

/** Lifecycle hooks fired around a submit (in addition to the returned promise). */
interface SubmitCallbacks<R> {
  onSuccess?: (result: R) => unknown
  onError?: (error: LukkError) => unknown
  onFinish?: () => unknown
  /** Send `data` as `multipart/form-data` even when it holds no `File`/`Blob`. */
  forceFormData?: boolean
}
/** Per-submit `ofetch` overrides (headers, `signal`, …) plus the lifecycle hooks. */
export type LukkFormSubmitOptions<R = unknown> = Omit<FetchOptions, 'method' | 'body' | 'query'> & SubmitCallbacks<R>

export interface UseLukkFormOptions {
  /** How long `recentlySuccessful` stays true after a successful submit (ms, default 2000). */
  recentlySuccessfulMs?: number
}

/** The reactive form returned by {@link useLukkForm}. Every mutator returns the form for chaining. */
export interface LukkForm<T extends FormFields> {
  /** The live, editable fields — bind with `v-model="form.data.x"`. */
  data: T
  /** First validation message per field, from the last `422`. */
  errors: FormErrors<T>
  /** True while a submit is in flight. */
  processing: boolean
  /** True after the last submit succeeded (reset at the next submit). */
  wasSuccessful: boolean
  /** True briefly after a success — for a transient "Saved!" indicator. */
  recentlySuccessful: boolean
  /** Whether any field currently has an error. */
  hasErrors: boolean
  /** Whether `data` differs from the current defaults (structural comparison). */
  isDirty: boolean
  setError: {
    (field: keyof T, message: string): LukkForm<T>
    (errors: FormErrors<T>): LukkForm<T>
  }
  clearErrors: (...fields: (keyof T)[]) => LukkForm<T>
  reset: (...fields: (keyof T)[]) => LukkForm<T>
  resetAndClearErrors: (...fields: (keyof T)[]) => LukkForm<T>
  defaults: {
    (field: keyof T, value: T[keyof T]): LukkForm<T>
    (fields?: Partial<T>): LukkForm<T>
  }
  transform: (callback: (data: T) => Record<string, unknown>) => LukkForm<T>
  submit: <R = unknown>(method: FormMethod, url: string, options?: LukkFormSubmitOptions<R>) => Promise<R>
  get: <R = unknown>(url: string, options?: LukkFormSubmitOptions<R>) => Promise<R>
  post: <R = unknown>(url: string, options?: LukkFormSubmitOptions<R>) => Promise<R>
  put: <R = unknown>(url: string, options?: LukkFormSubmitOptions<R>) => Promise<R>
  patch: <R = unknown>(url: string, options?: LukkFormSubmitOptions<R>) => Promise<R>
  delete: <R = unknown>(url: string, options?: LukkFormSubmitOptions<R>) => Promise<R>
  /** Abort the most-recent in-flight submit (unless you passed your own `signal`); it rejects with an `AbortError`. */
  cancel: () => void
}

/**
 * Deep-clone plain form data for the reset/`isDirty` baseline — but pass `File`/`Blob` **by
 * reference** (never byte-copy an upload) and copy `Date`. This is what `reset()` restores and
 * the on-success rebase snapshots; the shape is the plain, cloneable data the form is meant to hold.
 */
function cloneData<V>(value: V): V {
  if (value instanceof Blob) return value // File/Blob (uploads): reference, don't byte-copy
  if (value instanceof Date) return new Date(value.getTime()) as V
  if (Array.isArray(value)) return value.map(cloneData) as V
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) out[key] = cloneData(item)
    return out as V
  }
  return value
}

/** Whether a value tree contains a `File`/`Blob` (so the submit must use `multipart/form-data`). */
function hasFiles(value: unknown): boolean {
  if (value instanceof Blob) return true
  if (Array.isArray(value)) return value.some(hasFiles)
  if (value !== null && typeof value === 'object') return Object.values(value).some(hasFiles)
  return false
}

/** Flatten an object into `FormData` with Laravel-style bracket keys (`a[b][0]`). */
function toFormData(source: Record<string, unknown>): FormData {
  const form = new FormData()
  for (const [key, value] of Object.entries(source)) appendFormData(form, key, value)
  return form
}
function appendFormData(form: FormData, key: string, value: unknown): void {
  if (Array.isArray(value)) value.forEach((item, i) => appendFormData(form, `${key}[${i}]`, item))
  else if (value instanceof File) form.append(key, value, value.name)
  else if (value instanceof Blob) form.append(key, value)
  else if (value instanceof Date) form.append(key, value.toISOString())
  else if (typeof value === 'boolean') form.append(key, value ? '1' : '0') // Laravel truthiness
  else if (value === null || value === undefined) form.append(key, '')
  else if (typeof value === 'object') for (const [k, v] of Object.entries(value)) appendFormData(form, `${key}[${k}]`, v)
  else form.append(key, String(value))
}

/**
 * A reactive form bound to your app API through {@link useLukkFetch}, in the spirit of
 * Inertia's `useForm`: hold the fields, submit them, and map a Laravel `422` bag onto
 * per-field errors — without the SSR-cookie / bearer / transport plumbing.
 *
 * ```ts
 * const form = useLukkForm({ email: '', password: '' })
 * await form.post('/register')          // form.data is the body
 * form.errors.email                     // ← first 422 message for `email`, if any
 * form.processing                       // ← true while in flight
 * ```
 *
 * Fields live under `form.data.*` (not spread onto the form) so a field can safely be
 * named `errors`, `processing`, `submit`, … Each call returns an independent form.
 *
 * `initial` must hold plain, structured-cloneable values (strings, numbers, booleans,
 * arrays, plain objects, `Date`/`File`) — that's what `reset()`/`isDirty` deep-copy and
 * compare; don't pass functions, class instances, or reactive proxies.
 */
export function useLukkForm<T extends FormFields>(initial: T, options: UseLukkFormOptions = {}): LukkForm<T> {
  const api = useLukkFetch()
  const recentlySuccessfulMs = options.recentlySuccessfulMs ?? 2000

  const data = reactive(cloneData(initial)) as T
  // A plain-object deep clone of the live data (File/Blob by reference).
  const snapshot = (): FormFields => cloneData(data) as FormFields
  // The reset/`isDirty` baseline — a shallowRef so `.value` stays a plain object while
  // reassignment (`defaults()`, the on-success rebase) still triggers reactivity.
  const baseline = shallowRef<FormFields>(cloneData(initial) as FormFields)
  // A ref (not reactive) so `keyof T` still indexes it — still deeply reactive.
  const errors = ref<FormErrors<T>>({})
  const processing = ref(false)
  const wasSuccessful = ref(false)
  const recentlySuccessful = ref(false)
  const hasErrors = computed(() => Object.keys(errors.value).length > 0)
  // Structural (JSON) comparison — fine for the plain data this form is meant to hold. Note it
  // does not diff `File`/`Blob` fields (both serialize to `{}`); track those out of band.
  const isDirty = computed(() => JSON.stringify(data) !== JSON.stringify(baseline.value))

  let transformFn: ((data: T) => Record<string, unknown>) | null = null
  let recentlyTimer: ReturnType<typeof setTimeout> | undefined
  let inFlight: AbortController | undefined

  function setError(field: keyof T, message: string): LukkForm<T>
  function setError(errorBag: FormErrors<T>): LukkForm<T>
  function setError(fieldOrBag: keyof T | FormErrors<T>, message?: string): LukkForm<T> {
    if (typeof fieldOrBag === 'object') Object.assign(errors.value, fieldOrBag)
    else errors.value[fieldOrBag] = message
    return form
  }

  /** Clear the named field errors, or all of them when called with no arguments. */
  function clearErrors(...fields: (keyof T)[]): LukkForm<T> {
    if (!fields.length) {
      errors.value = {}
      return form
    }
    const drop = new Set<keyof T>(fields)
    errors.value = Object.fromEntries(
      Object.entries(errors.value).filter(([key]) => !drop.has(key as keyof T)),
    ) as FormErrors<T>
    return form
  }

  /** Restore the named fields to their current defaults, or all of them by default. */
  function reset(...fields: (keyof T)[]): LukkForm<T> {
    const src = baseline.value
    const keys = fields.length ? fields : Object.keys(src)
    // Own-key guard: an unknown field name (e.g. via a cast) must not inject an
    // `undefined` key that then drifts into the next submit payload.
    for (const key of keys) {
      if (Object.hasOwn(src, key as string)) (data as FormFields)[key as string] = cloneData(src[key as string])
    }
    return form
  }

  /** Reset the named fields (or all) AND clear their errors. */
  function resetAndClearErrors(...fields: (keyof T)[]): LukkForm<T> {
    reset(...fields)
    return clearErrors(...fields)
  }

  function setDefaults(field: keyof T, value: T[keyof T]): LukkForm<T>
  function setDefaults(fields?: Partial<T>): LukkForm<T>
  function setDefaults(fieldOrBag?: keyof T | Partial<T>, value?: T[keyof T]): LukkForm<T> {
    // Re-baseline what `reset()` restores to and `isDirty` compares against. Always reassign
    // (never mutate in place) so the shallowRef triggers `isDirty`/`reset`. Only keep keys that
    // exist in `data` — a stray key would make `isDirty` permanently true and drift `reset()`.
    if (fieldOrBag === undefined) {
      baseline.value = snapshot()
    }
    else if (typeof fieldOrBag === 'object') {
      const known = Object.fromEntries(Object.entries(fieldOrBag).filter(([key]) => Object.hasOwn(data, key)))
      baseline.value = { ...baseline.value, ...cloneData(known) }
    }
    else if (Object.hasOwn(data, fieldOrBag as string)) {
      baseline.value = { ...baseline.value, [fieldOrBag as string]: cloneData(value) }
    }
    return form
  }

  /** Register a callback that maps `data` to the payload sent on every subsequent submit. */
  function transform(callback: (data: T) => Record<string, unknown>): LukkForm<T> {
    transformFn = callback
    return form
  }

  /** Abort the most-recent in-flight submit — it rejects with an `AbortError` (no-op if you passed your own signal). */
  function cancel(): void {
    inFlight?.abort()
  }

  /**
   * Submit `data` to `url`. Clears then (on a `422`) re-populates `errors`, toggles
   * `processing`, fires the lifecycle hooks, and rethrows the {@link LukkError} so a caller
   * can branch on it. On success it returns the parsed body and re-baselines the defaults
   * (so `isDirty` flips false), unless the `onSuccess` hook re-set them itself.
   * `get` sends the (flat) fields as the query string; every other verb sends them as the body,
   * switching to `multipart/form-data` when the payload holds a `File`/`Blob` (put uploads on a
   * body verb — a file in a `get` query is stringified and lost).
   */
  async function submit<R = unknown>(method: FormMethod, url: string, options: LukkFormSubmitOptions<R> = {}): Promise<R> {
    const { onSuccess, onError, onFinish, forceFormData, ...fetchOptions } = options
    processing.value = true
    wasSuccessful.value = false
    recentlySuccessful.value = false
    if (recentlyTimer) clearTimeout(recentlyTimer)
    clearErrors()
    // A plain snapshot — don't hand the reactive proxy to the serializer.
    const source = { ...data } as T
    const payload = transformFn ? transformFn(source) : source
    // Send multipart when the payload carries a File/Blob (or it's forced); GET stays query.
    const asFormData = method !== 'get' && (forceFormData === true || hasFiles(payload))
    const carrier = method === 'get'
      ? { query: payload }
      : { body: asFormData ? toFormData(payload as Record<string, unknown>) : payload }
    // Our own controller powers `cancel()`; a caller's own `signal` (in fetchOptions) wins.
    const controller = new AbortController()
    inFlight = controller

    let result: R
    try {
      result = await api(url, { method, ...carrier, signal: controller.signal, ...fetchOptions }) as R
    }
    catch (error) {
      processing.value = false
      const bag = (error as LukkError | null)?.errors
      if (bag) {
        // Guard the shape: a non-conforming/empty bag must not mask the LukkError with a
        // TypeError, nor leave a phantom key (present in `errors` but with no message).
        for (const [field, messages] of Object.entries(bag)) {
          if (Array.isArray(messages) && messages.length) errors.value[field as keyof T] = messages[0]
        }
      }
      await onError?.(error as LukkError)
      await onFinish?.() // finally-hook: fires on failure too
      throw error
    }

    processing.value = false
    wasSuccessful.value = true
    recentlySuccessful.value = true
    recentlyTimer = setTimeout(() => { recentlySuccessful.value = false }, recentlySuccessfulMs)
    // Snapshot the baseline identity now; `defaults()` (which always reassigns it) inside
    // onSuccess will change it — a per-submit check that's immune to a concurrent submit.
    const baselineBeforeSuccess = baseline.value
    try {
      await onSuccess?.(result)
      // Rebase to the just-submitted data (so `isDirty` clears), unless the success hook
      // already re-set the defaults itself (e.g. `defaults()`; `form.reset()` for a create form
      // leaves the baseline identity intact and correctly rebases to the reset data).
      if (baseline.value === baselineBeforeSuccess) baseline.value = snapshot()
    }
    finally {
      await onFinish?.() // finally-hook: fires even if onSuccess throws
    }
    return result
  }

  const form = reactive({
    data,
    errors,
    processing,
    wasSuccessful,
    recentlySuccessful,
    hasErrors,
    isDirty,
    setError,
    clearErrors,
    reset,
    resetAndClearErrors,
    defaults: setDefaults,
    transform,
    cancel,
    submit,
    get: <R = unknown>(url: string, opts?: LukkFormSubmitOptions<R>) => submit<R>('get', url, opts),
    post: <R = unknown>(url: string, opts?: LukkFormSubmitOptions<R>) => submit<R>('post', url, opts),
    put: <R = unknown>(url: string, opts?: LukkFormSubmitOptions<R>) => submit<R>('put', url, opts),
    patch: <R = unknown>(url: string, opts?: LukkFormSubmitOptions<R>) => submit<R>('patch', url, opts),
    delete: <R = unknown>(url: string, opts?: LukkFormSubmitOptions<R>) => submit<R>('delete', url, opts),
  }) as unknown as LukkForm<T>

  return form
}

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LukkError } from 'lukk-core'

// useLukkForm submits through useLukkFetch — mock it with a controllable fake.
const { api } = vi.hoisted(() => ({ api: vi.fn() }))
vi.mock('../src/runtime/composables/useLukkFetch', () => ({ useLukkFetch: () => api }))

// eslint-disable-next-line import/first
import { useLukkForm } from '../src/runtime/composables/useLukkForm'

const val422 = (errors: Record<string, string[]>): LukkError => ({ status: 422, message: 'The given data was invalid.', errors })

beforeEach(() => { api.mockReset().mockResolvedValue({ ok: true }) })

describe('useLukkForm', () => {
  it('starts from the initial data, clean and idle', () => {
    const form = useLukkForm({ email: 'a@b.c', password: '' })
    expect(form.data).toEqual({ email: 'a@b.c', password: '' })
    expect(form.errors).toEqual({})
    expect(form.processing).toBe(false)
    expect(form.hasErrors).toBe(false)
  })

  it('post sends the data as the body and returns the parsed response', async () => {
    const form = useLukkForm({ email: 'e', password: 'p' })
    const result = await form.post('/register')
    expect(api).toHaveBeenCalledWith('/register', expect.objectContaining({ method: 'post', body: { email: 'e', password: 'p' } }))
    expect(result).toEqual({ ok: true })
  })

  it('get sends the data as the query string', async () => {
    const form = useLukkForm({ q: 'term', page: 2 })
    await form.get('/search')
    expect(api).toHaveBeenCalledWith('/search', expect.objectContaining({ method: 'get', query: { q: 'term', page: 2 } }))
  })

  it('routes put/patch/delete and merges per-submit options', async () => {
    const form = useLukkForm({ name: 'x' })
    await form.put('/a', { headers: { 'x-h': '1' } })
    await form.patch('/b')
    await form.delete('/c')
    expect(api).toHaveBeenNthCalledWith(1, '/a', expect.objectContaining({ method: 'put', body: { name: 'x' }, headers: { 'x-h': '1' } }))
    expect(api).toHaveBeenNthCalledWith(2, '/b', expect.objectContaining({ method: 'patch', body: { name: 'x' } }))
    expect(api).toHaveBeenNthCalledWith(3, '/c', expect.objectContaining({ method: 'delete', body: { name: 'x' } }))
  })

  it('generic submit sends live (mutated) data', async () => {
    const form = useLukkForm({ name: 'x' })
    form.data.name = 'edited'
    await form.submit('post', '/save')
    expect(api).toHaveBeenCalledWith('/save', expect.objectContaining({ method: 'post', body: { name: 'edited' } }))
  })

  it('toggles processing across the request lifecycle', async () => {
    const form = useLukkForm({ a: 1 })
    let release!: (v: unknown) => void
    api.mockReturnValueOnce(new Promise((r) => { release = r }))

    const pending = form.post('/x')
    expect(form.processing).toBe(true)
    release({ ok: true })
    await pending
    expect(form.processing).toBe(false)
  })

  it('maps a 422 bag onto per-field errors (first message) and rethrows', async () => {
    const form = useLukkForm({ email: '', password: '' })
    api.mockRejectedValueOnce(val422({ email: ['Email is required.', 'and taken'], password: ['Too short.'] }))

    await expect(form.post('/register')).rejects.toMatchObject({ status: 422 })
    expect(form.errors).toEqual({ email: 'Email is required.', password: 'Too short.' })
    expect(form.hasErrors).toBe(true)
    expect(form.processing).toBe(false) // reset even on failure
  })

  it('clears previous errors before each submit (clear-then-set)', async () => {
    const form = useLukkForm({ email: '' })
    api.mockRejectedValueOnce(val422({ email: ['First.'] }))
    await expect(form.post('/x')).rejects.toBeTruthy()
    expect(form.errors.email).toBe('First.')

    // A clean second submit wipes the stale error.
    await form.post('/x')
    expect(form.errors).toEqual({})
    expect(form.hasErrors).toBe(false)
  })

  it('leaves errors untouched and still resets processing on a non-validation failure', async () => {
    const form = useLukkForm({ email: '' })
    form.setError('email', 'stale')
    api.mockRejectedValueOnce({ status: 500, message: 'Server error' } satisfies LukkError)

    await expect(form.post('/x')).rejects.toMatchObject({ status: 500 })
    // clearErrors ran (clear-then-set), and no 422 bag → nothing re-set.
    expect(form.errors).toEqual({})
    expect(form.processing).toBe(false)
  })

  it('tolerates a thrown null / non-object rejection', async () => {
    const form = useLukkForm({ a: 1 })
    api.mockRejectedValueOnce(null)
    await expect(form.post('/x')).rejects.toBeNull()
    expect(form.errors).toEqual({})
  })

  it('ignores a malformed 422 bag (empty/non-array values) without masking the LukkError', async () => {
    const form = useLukkForm({ email: '', name: '' })
    // A non-conforming server: empty array, and a null where a string[] is expected.
    api.mockRejectedValueOnce(val422({ email: [], name: null as unknown as string[] }))

    await expect(form.post('/x')).rejects.toMatchObject({ status: 422 }) // original error, not a TypeError
    expect(form.errors).toEqual({}) // no phantom keys
    expect(form.hasErrors).toBe(false)
    expect(form.processing).toBe(false)
  })

  it('setError accepts a single field or a whole bag', () => {
    const form = useLukkForm({ email: '', name: '' })
    form.setError('email', 'Bad email.')
    expect(form.errors).toEqual({ email: 'Bad email.' })
    form.setError({ name: 'Required.', email: 'Taken.' })
    expect(form.errors).toEqual({ email: 'Taken.', name: 'Required.' })
    expect(form.hasErrors).toBe(true)
  })

  it('clearErrors clears named fields, or all when called bare', () => {
    const form = useLukkForm({ email: '', name: '' })
    form.setError({ email: 'e', name: 'n' })
    form.clearErrors('email')
    expect(form.errors).toEqual({ name: 'n' })
    form.clearErrors()
    expect(form.errors).toEqual({})
  })

  it('reset restores named fields, or everything by default, with an independent deep copy', () => {
    const form = useLukkForm({ email: 'init', profile: { name: 'Ada' } })
    form.data.email = 'changed'
    form.data.profile.name = 'Bob'

    form.reset('email')
    expect(form.data.email).toBe('init')
    expect(form.data.profile.name).toBe('Bob') // untouched — only `email` reset

    form.reset()
    expect(form.data).toEqual({ email: 'init', profile: { name: 'Ada' } })

    // The restored nested object is a fresh clone, not the initial reference.
    form.data.profile.name = 'Cy'
    form.reset()
    expect(form.data.profile.name).toBe('Ada')
  })

  it('reset ignores an unknown field name (no undefined key injected)', () => {
    const form = useLukkForm({ email: 'init' })
    ;(form.reset as (...f: string[]) => void)('nope') // bypass keyof T via cast
    expect(form.data).toEqual({ email: 'init' }) // no `nope: undefined` key added
  })

  it('mutators are chainable (return the form)', () => {
    const form = useLukkForm({ a: '', b: '' })
    expect(form.setError('a', 'x')).toBe(form)
    expect(form.setError({ b: 'y' })).toBe(form)
    expect(form.clearErrors('a')).toBe(form)
    expect(form.reset()).toBe(form)
    expect(form.resetAndClearErrors()).toBe(form)
    expect(form.transform(d => d)).toBe(form)
    expect(form.defaults()).toBe(form)
  })

  it('resetAndClearErrors restores data and clears errors together', () => {
    const form = useLukkForm({ email: 'a' })
    form.data.email = 'b'
    form.setError('email', 'oops')
    form.resetAndClearErrors()
    expect(form.data.email).toBe('a')
    expect(form.errors).toEqual({})
  })

  it('tracks isDirty against the current defaults, including nested fields', () => {
    const form = useLukkForm({ email: 'a', profile: { name: 'Ada' } })
    expect(form.isDirty).toBe(false)
    form.data.email = 'b'
    expect(form.isDirty).toBe(true)
    form.reset()
    expect(form.isDirty).toBe(false)
    form.data.profile.name = 'Bob'
    expect(form.isDirty).toBe(true)
  })

  it('transform maps the payload before every submit (and is a no-op until set)', async () => {
    const form = useLukkForm({ password: 'p', password_confirmation: 'p' })
    await form.post('/a') // no transform yet → full data
    expect(api).toHaveBeenLastCalledWith('/a', expect.objectContaining({ method: 'post', body: { password: 'p', password_confirmation: 'p' } }))

    form.transform(d => ({ password: d.password }))
    await form.post('/b')
    expect(api).toHaveBeenLastCalledWith('/b', expect.objectContaining({ method: 'post', body: { password: 'p' } }))
  })

  it('defaults() re-baselines what reset restores to and isDirty compares against', () => {
    const form = useLukkForm({ email: 'a', name: '' })
    form.data.email = 'b'
    form.data.name = 'Ada'
    form.defaults() // baseline := current data
    expect(form.isDirty).toBe(false)

    form.data.email = 'c'
    form.reset('email')
    expect(form.data.email).toBe('b') // the NEW default, not the original 'a'
  })

  it('defaults(field, value) and defaults(bag) set specific baselines', () => {
    const form = useLukkForm({ email: 'a', name: 'x' })
    form.defaults('email', 'new@e.c')
    form.defaults({ name: 'Bob' })
    form.reset()
    expect(form.data).toEqual({ email: 'new@e.c', name: 'Bob' })
  })

  it('sets wasSuccessful/recentlySuccessful on success and clears the latter after the duration', async () => {
    vi.useFakeTimers()
    try {
      const form = useLukkForm({ a: 1 }, { recentlySuccessfulMs: 1000 })
      await form.post('/x')
      expect(form.wasSuccessful).toBe(true)
      expect(form.recentlySuccessful).toBe(true)
      vi.advanceTimersByTime(1000)
      expect(form.recentlySuccessful).toBe(false)
      expect(form.wasSuccessful).toBe(true) // sticks until the next submit
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('resets wasSuccessful at the start of the next submit', async () => {
    const form = useLukkForm({ a: 1 })
    await form.post('/x')
    expect(form.wasSuccessful).toBe(true)

    let release!: (v: unknown) => void
    api.mockReturnValueOnce(new Promise((r) => { release = r }))
    const pending = form.post('/y')
    expect(form.wasSuccessful).toBe(false) // reset at start, before it resolves
    release({ ok: true })
    await pending
    expect(form.wasSuccessful).toBe(true)
  })

  it('re-baselines defaults on success so isDirty clears', async () => {
    const form = useLukkForm({ title: '' })
    form.data.title = 'Hello'
    expect(form.isDirty).toBe(true)
    await form.post('/posts')
    expect(form.isDirty).toBe(false) // rebased to the submitted values
    form.data.title = 'edited'
    form.reset()
    expect(form.data.title).toBe('Hello') // reset now goes to the saved value
  })

  it('lets onSuccess reset a create form (data cleared, baseline follows)', async () => {
    const form = useLukkForm({ title: '' })
    form.data.title = 'Hello'
    await form.post('/posts', { onSuccess: () => form.reset() })
    expect(form.data.title).toBe('') // reset ran in onSuccess (before the rebase)
    expect(form.isDirty).toBe(false)
  })

  it('lets onSuccess call defaults() to own the baseline (skips the auto-rebase)', async () => {
    const form = useLukkForm({ title: 'orig' })
    form.data.title = 'edited'
    await form.post('/x', { onSuccess: () => form.defaults('title', 'custom') })
    form.reset()
    expect(form.data.title).toBe('custom') // auto-rebase skipped; explicit default won
  })

  it('fires onSuccess with the result and onFinish on success', async () => {
    const form = useLukkForm({ a: 1 })
    const onSuccess = vi.fn()
    const onFinish = vi.fn()
    api.mockResolvedValueOnce({ id: 7 })
    await form.post('/x', { onSuccess, onFinish })
    expect(onSuccess).toHaveBeenCalledWith({ id: 7 })
    expect(onFinish).toHaveBeenCalledOnce()
  })

  it('fires onError with the LukkError and onFinish on failure, then rethrows', async () => {
    const form = useLukkForm({ email: '' })
    const onError = vi.fn()
    const onFinish = vi.fn()
    api.mockRejectedValueOnce(val422({ email: ['bad'] }))
    await expect(form.post('/x', { onError, onFinish })).rejects.toMatchObject({ status: 422 })
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ status: 422 }))
    expect(onFinish).toHaveBeenCalledOnce()
    expect(form.errors.email).toBe('bad')
  })

  it('still runs onFinish (and rethrows) when onSuccess throws', async () => {
    const form = useLukkForm({ a: 1 })
    const onFinish = vi.fn()
    const boom = new Error('handler blew up')
    await expect(form.post('/x', { onSuccess: () => { throw boom }, onFinish })).rejects.toBe(boom)
    expect(onFinish).toHaveBeenCalledOnce()
    expect(form.processing).toBe(false) // not left stuck
  })

  it('ignores defaults() for a key not present in data (no phantom key, isDirty stays honest)', () => {
    const form = useLukkForm({ a: 1 })
    ;(form.defaults as (f: string, v: unknown) => void)('b', 2) // unknown field via cast
    ;(form.defaults as (bag: Record<string, unknown>) => void)({ c: 3 }) // unknown in a bag
    expect(form.isDirty).toBe(false) // baseline still just { a: 1 }
    form.reset()
    expect(form.data).toEqual({ a: 1 }) // no b/c drifted into data
  })

  it('auto-sends multipart/form-data when a field holds a File, flattening nested keys', async () => {
    const file = new File(['hello'], 'note.txt', { type: 'text/plain' })
    const form = useLukkForm({ title: 'Hi', published: true, avatar: file, tags: ['a', 'b'], meta: { views: 3 } })
    await form.post('/posts')

    const body = (api.mock.calls.at(-1)![1] as { body: unknown }).body
    expect(body).toBeInstanceOf(FormData)
    const fd = body as FormData
    expect(fd.get('title')).toBe('Hi')
    expect(fd.get('published')).toBe('1') // boolean → Laravel truthiness
    expect(fd.get('avatar')).toBeInstanceOf(File)
    expect((fd.get('avatar') as File).name).toBe('note.txt')
    expect(fd.get('tags[0]')).toBe('a')
    expect(fd.get('tags[1]')).toBe('b')
    expect(fd.get('meta[views]')).toBe('3') // nested object → bracket key
  })

  it('serializes File, Blob, Date, booleans, null, arrays and nested objects into FormData', async () => {
    const doc = new File(['d'], 'd.pdf')
    const blob = new Blob(['x'], { type: 'text/plain' })
    const when = new Date('2020-01-02T03:04:05.000Z')
    const form = useLukkForm({
      docs: [doc], // a File nested in an array
      raw: blob, // a bare Blob (no filename)
      when, // Date → ISO string
      note: null, // null → ''
      flag: false, // boolean → '0'
      nested: { inner: 'v' }, // nested object → bracket key
    })
    await form.post('/x')

    const fd = (api.mock.calls.at(-1)![1] as { body: FormData }).body
    expect(fd).toBeInstanceOf(FormData)
    expect((fd.get('docs[0]') as File).name).toBe('d.pdf')
    expect(fd.get('raw')).toBeInstanceOf(Blob)
    expect(fd.get('when')).toBe('2020-01-02T03:04:05.000Z')
    expect(fd.get('note')).toBe('')
    expect(fd.get('flag')).toBe('0')
    expect(fd.get('nested[inner]')).toBe('v')
  })

  it('passes File/Blob fields by reference (no byte-copy) through construction, reset, and the success rebase', async () => {
    const file = new File(['x'], 'a.txt')
    const form = useLukkForm({ avatar: file, name: '' })
    expect(form.data.avatar).toBe(file) // construction cloned the data but not the File
    form.data.name = 'edited'
    form.reset()
    expect(form.data.avatar).toBe(file) // reset restored the same reference
    await form.post('/x') // success rebases the baseline
    form.reset()
    expect(form.data.avatar).toBe(file) // still the same File, never byte-copied
  })

  it('sends multipart when forceFormData is set, even without a file', async () => {
    const form = useLukkForm({ name: 'x' })
    await form.post('/a', { forceFormData: true })
    const body = (api.mock.calls.at(-1)![1] as { body: unknown }).body
    expect(body).toBeInstanceOf(FormData)
    expect((body as FormData).get('name')).toBe('x')
  })

  it('keeps a JSON body when there are no files and forceFormData is off', async () => {
    const form = useLukkForm({ name: 'x' })
    await form.post('/a')
    expect((api.mock.calls.at(-1)![1] as { body: unknown }).body).toEqual({ name: 'x' })
  })

  it('passes an AbortSignal and cancel() aborts it', async () => {
    const form = useLukkForm({ a: 1 })
    api.mockImplementationOnce((_url: string, opts: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        opts.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      }),
    )
    const pending = form.post('/slow')
    form.cancel()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(form.processing).toBe(false)
  })
})

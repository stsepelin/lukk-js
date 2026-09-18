import { afterEach, describe, expect, it, vi } from 'vitest'

const sessionReplaced = vi.fn(async (key: string | undefined) => key === 'REPLACED')
vi.mock('../src/runtime/server/ended-sessions', async importActual => ({
  ...(await importActual<typeof import('../src/runtime/server/ended-sessions')>()),
  sessionReplaced: (key: string | undefined) => sessionReplaced(key),
}))

// eslint-disable-next-line import/first
import plugin from '../src/runtime/server/plugins/finish-logout-render'

type Hook = (first: unknown, second?: unknown) => Promise<void>

/** The plugin's hooks, by name. */
function install(): Record<string, Hook> {
  const hooks: Record<string, Hook> = {}
  ;(plugin as unknown as (app: unknown) => void)({ hooks: { hook: (name: string, fn: Hook) => { hooks[name] = fn } } })
  expect(Object.keys(hooks).sort()).toEqual(['beforeResponse', 'render:html'])
  return hooks
}

/** Run a hook the way Nitro calls it: `beforeResponse(event, response)`, `render:html(html, { event })`. */
function call(hooks: Record<string, Hook>, name: string, event: unknown) {
  return name === 'beforeResponse' ? hooks[name]!(event, { body: '' }) : hooks[name]!('<html>', { event })
}

function pageEvent(ended: unknown, headersSent = false) {
  const headers = new Map<string, unknown>([['set-cookie', [
    '__Host-lukk-signed-out=1; Max-Age=10; Path=/; Secure; SameSite=Strict',
    'theme=dark; Path=/',
  ]]])
  return {
    headers,
    event: {
      context: ended === undefined ? {} : { lukkEndedSession: ended },
      node: { res: {
        headersSent,
        getHeader: (k: string) => headers.get(k),
        setHeader: (k: string, v: unknown) => { headers.set(k, v) },
        removeHeader: (k: string) => { headers.delete(k) },
      } },
    },
  }
}

afterEach(() => vi.clearAllMocks())

describe('finish-logout late check (BFF)', () => {
  const ended = (key: string | undefined) => ({ key, marker: '__Host-lukk-signed-out' })

  // `beforeResponse`: pages, redirects, API routes, errors; `render:html`: a page behind a cached route rule.
  it.each(['beforeResponse', 'render:html'])('%s holds back the signed-out cookie when a sign-in replaced that session meanwhile', async (name) => {
    const hooks = install()
    const page = pageEvent(ended('REPLACED'))
    await call(hooks, name, page.event)
    expect(page.headers.get('set-cookie')).toEqual(['theme=dark; Path=/'])
  })

  it('beforeResponse restates the per-user headers for a request that never got as far as ending anything', async () => {
    // The unsealable-cookie and back-off branches return before `lukkEndedSession` is set, and a cached
    // route rule overwrites the `cache-control` the middleware set on the way in.
    const hooks = install()
    const page = pageEvent(undefined)
    ;(page.event.context as { lukkPerVisitor?: boolean }).lukkPerVisitor = true

    await call(hooks, 'beforeResponse', page.event)

    expect(page.headers.get('cache-control')).toBe('no-store')
    expect(page.headers.get('vary')).toBe('cookie')
  })

  it.each(['beforeResponse', 'render:html'])('%s lets them go when nothing replaced it, for a response that finished no logout, and once the headers are out', async (name) => {
    const hooks = install()
    for (const page of [pageEvent(ended('S1')), pageEvent(ended(undefined)), pageEvent(undefined), pageEvent(ended('REPLACED'), true)]) {
      await call(hooks, name, page.event)
      expect(page.headers.get('set-cookie')).toHaveLength(2)
    }
  })
})

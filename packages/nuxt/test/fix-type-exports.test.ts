import { describe, expect, it } from 'vitest'
// @ts-expect-error — a plain .mjs build script, untyped
import { valueExports } from '../scripts/fix-type-exports.mjs'

describe('the type entry the package publishes', () => {
  it('re-exports the constants as values, so importing one type-checks', () => {
    const generated = `export type ModuleOptions = {}\n\nexport { type LUKK_BFF_PREFIX, type LUKK_SESSION_COOKIE } from './module.js'\n`

    expect(valueExports(generated)).toBe(`export type ModuleOptions = {}\n\nexport { LUKK_BFF_PREFIX, LUKK_SESSION_COOKIE } from './module.js'\n`)
  })

  it('leaves the type-only lines alone', () => {
    const generated = `import type { NuxtModule } from '@nuxt/schema'\nexport type ModuleOptions = {}\n`

    expect(valueExports(generated)).toBe(generated)
  })
})

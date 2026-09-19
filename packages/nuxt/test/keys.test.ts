import { describe, expect, it } from 'vitest'
import * as keys from '../src/runtime/keys'

describe('useState keys', () => {
  it('are distinct and namespaced, so they never collide with each other or with the app\'s own state', () => {
    // `useState` keys are global to the Nuxt app and ride in the SSR payload. An app's own
    // `useState('user')` must never alias lukk's user, and two lukk keys must never alias each other.
    const values = Object.values(keys)

    expect(values.length).toBeGreaterThan(0)
    expect(new Set(values).size).toBe(values.length)
    for (const key of values) expect(key).toMatch(/^lukk:[a-z-]+$/)
  })
})

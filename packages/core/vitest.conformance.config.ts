import { defineConfig } from 'vitest/config'

// Live conformance run: exercises lukk-core against a REAL lukk instance
// (see ../../conformance). No coverage gate — this validates the contract, not lines.
export default defineConfig({
  test: {
    include: ['conformance/**/*.conformance.test.ts'],
    testTimeout: 15_000,
    hookTimeout: 30_000,
  },
})

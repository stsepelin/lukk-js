import { configDefaults, defineConfig } from 'vitest/config'

/**
 * Vitest for Stryker: the ordinary config, minus the 100% coverage gate.
 *
 * Stryker runs a SUBSET of the suite per mutant, so the coverage thresholds fail every run and it reads
 * that as "no tests executed". Coverage and mutation score answer different questions — how much of the
 * code ran, versus whether anything would notice if it changed — and only the second one is asked here.
 */
export default defineConfig({
  test: {
    exclude: [
      ...configDefaults.exclude,
      // Never the Stryker sandbox: it holds an instrumented COPY of these very files, so a stale
      // one makes the suite run a mutated duplicate of itself.
      '**/.stryker-tmp/**',
      'conformance/**',
    ],
  },
})

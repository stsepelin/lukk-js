import { fileURLToPath } from 'node:url'
import { configDefaults, defineConfig } from 'vitest/config'

/**
 * Vitest for Stryker: the client project only, and no coverage gate.
 *
 * Stryker runs a SUBSET of the suite per mutant, so the 100% coverage thresholds fail every run and it
 * reads that as "no tests executed". Coverage and mutation score answer different questions — how much of
 * the code ran, versus whether anything would notice if it changed.
 *
 * One project, not two: `import.meta.server` is replaced at transform time, so the server-env project
 * compiles the same sources differently. Stryker instruments one build, and mixing the two makes every
 * `import.meta.server` branch look like a survivor. The server build keeps its own coverage gate in
 * `vitest.config.ts`, which is what pins those branches.
 */
export default defineConfig({
  define: { 'import.meta.client': 'true', 'import.meta.server': 'false', 'import.meta.dev': 'true' },
  resolve: {
    alias: { '#imports': fileURLToPath(new URL('./test/mocks/imports.ts', import.meta.url)) },
  },
  test: {
    exclude: [...configDefaults.exclude, 'test/integration/**', 'test/server-env/**'],
  },
})

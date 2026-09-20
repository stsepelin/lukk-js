import { fileURLToPath } from 'node:url'
import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  // The runtime is unit-tested as the client (Nuxt defines these at build time).
  define: { 'import.meta.client': 'true', 'import.meta.server': 'false', 'import.meta.dev': 'true' },
  resolve: {
    // Unit-test runtime code (composables/plugins/middleware) without booting Nuxt.
    alias: { '#imports': fileURLToPath(new URL('./test/mocks/imports.ts', import.meta.url)) },
  },
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text-summary', 'text'],
      thresholds: { lines: 100, functions: 100, statements: 100, branches: 100 },
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'client',
          // Integration specs boot real sockets — run them via `test:integration`, not the coverage gate.
          exclude: [
            ...configDefaults.exclude,
            // Never the Stryker sandbox: it holds an instrumented COPY of these very files, so a stale
            // one makes the suite run a mutated duplicate of itself.
            '**/.stryker-tmp/**',
            'test/integration/**', 'test/server-env/**',
          ],
        },
      },
      {
        // The same runtime compiled as the SERVER. `import.meta.server` is replaced at transform time, so
        // a branch on it is invisible to 100% coverage from the client project alone — a mutation that
        // hard-coded the client value in a server-only path survived there.
        extends: true,
        define: { 'import.meta.client': 'false', 'import.meta.server': 'true' },
        test: { name: 'server-env', include: ['test/server-env/**/*.test.ts'] },
      },
    ],
  },
})

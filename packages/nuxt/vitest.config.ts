import { fileURLToPath } from 'node:url'
import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  // The runtime is unit-tested as the client (Nuxt defines these at build time).
  define: { 'import.meta.client': 'true', 'import.meta.server': 'false' },
  resolve: {
    // Unit-test runtime code (composables/plugins/middleware) without booting Nuxt.
    alias: { '#imports': fileURLToPath(new URL('./test/mocks/imports.ts', import.meta.url)) },
  },
  test: {
    // Integration specs boot real sockets — run them via `test:integration`, not the coverage gate.
    exclude: [...configDefaults.exclude, 'test/integration/**'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text-summary', 'text'],
      thresholds: { lines: 100, functions: 100, statements: 100, branches: 100 },
    },
  },
})

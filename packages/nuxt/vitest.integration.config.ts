import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Real-socket integration run for the BFF proxy (multipart upload + binary
// download through the actual h3 `proxyRequest`). No coverage gate — this proves
// transit, not lines.
export default defineConfig({
  define: { 'import.meta.client': 'true', 'import.meta.server': 'false' },
  resolve: {
    alias: { '#imports': fileURLToPath(new URL('./test/mocks/imports.ts', import.meta.url)) },
  },
  test: {
    include: ['test/integration/**/*.test.ts'],
    testTimeout: 15_000,
  },
})

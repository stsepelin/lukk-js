import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Conformance specs hit a live lukk instance — run them via `test:conformance`, not here.
    exclude: [...configDefaults.exclude, 'conformance/**'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text-summary', 'text'],
      thresholds: { lines: 100, functions: 100, statements: 100, branches: 100 },
    },
  },
})

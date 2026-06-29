import { createConfigForNuxt } from '@nuxt/eslint-config/flat'

export default createConfigForNuxt({
  features: { stylistic: true },
}).prepend({
  ignores: ['**/dist/**', '**/.nuxt/**', '**/.output/**', '**/coverage/**', '**/playground/.nuxt/**'],
}).append({
  rules: {
    // `request<void>` is how we type lukk's no-content endpoints — intentional and safe.
    '@typescript-eslint/no-invalid-void-type': 'off',
    // We use compact, single-purpose multi-statement lines deliberately (resets, test setup).
    '@stylistic/max-statements-per-line': 'off',
  },
})

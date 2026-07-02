import { createConfigForNuxt } from '@nuxt/eslint-config/flat'

export default createConfigForNuxt({
  features: { stylistic: true },
}).prepend({
  ignores: ['**/dist/**', '**/.nuxt/**', '**/.output/**', '**/coverage/**', '**/playground/.nuxt/**', '**/.vitepress/cache/**', '**/.vitepress/dist/**'],
}).append({
  rules: {
    // `request<void>` is how we type lukk's no-content endpoints — intentional and safe.
    '@typescript-eslint/no-invalid-void-type': 'off',
    // We use compact, single-purpose multi-statement lines deliberately (resets, test setup).
    '@stylistic/max-statements-per-line': 'off',
  },
}).append({
  // The E2E fixture apps use conventional single-word Nuxt page names (index/login/dashboard).
  files: ['conformance/apps/**/pages/**/*.vue', 'conformance/apps/**/app.vue'],
  rules: { 'vue/multi-word-component-names': 'off' },
})

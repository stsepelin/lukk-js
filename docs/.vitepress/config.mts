import { defineConfig } from 'vitepress'
import llmstxt from 'vitepress-plugin-llms'

// https://vitepress.dev/reference/site-config
export default defineConfig({
  title: 'lukk-js',
  description: 'First-party Laravel JWT auth for Nuxt — plus an auth-aware fetch and reactive forms for your own Laravel API.',
  base: '/lukk-js/',
  lastUpdated: true,
  // Docs use manual <a name="…"> anchors (GitHub-style), not heading ids, so skip the
  // build-time dead-link checker (the anchors still resolve at runtime).
  ignoreDeadLinks: true,
  head: [
    ['meta', { name: 'theme-color', content: '#3c8772' }],
  ],
  // Emit llms.txt + llms-full.txt (+ per-page .md) so AI tools can ingest the docs.
  // https://llmstxt.org
  vite: {
    plugins: [llmstxt()],
  },
  themeConfig: {
    nav: [
      { text: 'Guide', link: '/introduction' },
      { text: 'Config', link: '/configuration' },
      { text: 'Forms', link: '/forms' },
      { text: 'Reference', link: '/architecture' },
    ],
    sidebar: [
      {
        text: 'Getting Started',
        items: [
          { text: 'Introduction', link: '/introduction' },
          { text: 'Installation', link: '/installation' },
          { text: 'Configuration', link: '/configuration' },
        ],
      },
      {
        text: 'Core',
        items: [
          { text: 'Authentication', link: '/authentication' },
          { text: 'Transport Modes', link: '/transport-modes' },
          { text: 'Forms', link: '/forms' },
          { text: 'Using lukk-core', link: '/core' },
        ],
      },
      {
        text: 'Additional Features',
        items: [
          { text: 'Two-Factor Authentication', link: '/two-factor-authentication' },
          { text: 'Passkeys', link: '/passkeys' },
          { text: 'Confirmation', link: '/confirmation' },
          { text: 'Email Verification', link: '/email-verification' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'Architecture', link: '/architecture' },
        ],
      },
    ],
    socialLinks: [
      { icon: 'github', link: 'https://github.com/stsepelin/lukk-js' },
    ],
    search: { provider: 'local' },
    editLink: {
      pattern: 'https://github.com/stsepelin/lukk-js/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },
    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Unofficial companion to lukk — not affiliated with Laravel or Nuxt.',
    },
  },
})

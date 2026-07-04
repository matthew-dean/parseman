import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitepress'
import { faviconHead } from './head-icons'

const { version } = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../package.json'), 'utf8'),
) as { version: string }

// https://vitepress.dev/reference/site-config
export default defineConfig({
  title: 'Parséman',
  description:
    'Parser combinators that compile to optimized JavaScript — use as a library or as a build-time macro.',
  lang: 'en-US',
  // GitHub Pages project site — served from https://matthew-dean.github.io/parseman/
  base: '/parseman/',
  lastUpdated: true,
  cleanUrls: true,
  // Favicon set + PWA tags generated from assets/favicon.png (pnpm docs:favicons)
  head: faviconHead,
  themeConfig: {
    // https://vitepress.dev/reference/default-theme-config
    logo: 'https://raw.githubusercontent.com/matthew-dean/parseman/main/assets/parseman.png',
    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'Reference', link: '/reference/api' },
      {
        text: `v${version}`,
        items: [
          { text: 'Changelog', link: 'https://github.com/matthew-dean/parseman/releases' },
          { text: 'npm', link: 'https://www.npmjs.com/package/parseman' },
        ],
      },
    ],
    sidebar: {
      '/guide/': [
        {
          text: 'Introduction',
          collapsed: false,
          items: [
            { text: 'What is Parséman?', link: '/guide/getting-started' },
            { text: 'The three modes', link: '/guide/modes' },
            { text: 'Macro mode', link: '/guide/macro-mode' },
            { text: 'Benchmarks', link: '/guide/benchmarks' },
            { text: 'How Parséman compares', link: '/guide/comparison' },
          ],
        },
        {
          text: 'Writing grammars',
          collapsed: false,
          items: [
            { text: 'Combinators', link: '/guide/combinators' },
            { text: 'Whitespace & trivia', link: '/guide/trivia' },
            { text: 'Ordered choice & keywords', link: '/guide/keywords' },
            { text: 'Recursive rules', link: '/guide/recursive-rules' },
            { text: 'Extending grammars', link: '/guide/extending' },
          ],
        },
        {
          text: 'Building trees',
          collapsed: false,
          items: [
            { text: 'CST / AST nodes', link: '/guide/ast' },
            { text: 'Incremental re-parsing (experimental)', link: '/guide/incremental' },
            { text: 'Context-sensitive parsing', link: '/guide/context' },
          ],
        },
        {
          text: 'Robustness & speed',
          collapsed: false,
          items: [
            { text: 'Error recovery', link: '/guide/error-recovery' },
            { text: 'Performance', link: '/guide/performance' },
            { text: 'Under the hood: regex lowering', link: '/guide/regex-lowering' },
          ],
        },
      ],
      '/reference/': [
        {
          text: 'Reference',
          items: [
            { text: 'API', link: '/reference/api' },
            { text: 'Types', link: '/reference/types' },
          ],
        },
      ],
    },
    socialLinks: [
      { icon: 'github', link: 'https://github.com/matthew-dean/parseman' },
    ],
    editLink: {
      pattern: 'https://github.com/matthew-dean/parseman/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },
    search: {
      provider: 'local',
    },
    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © Matthew Dean',
    },
  },
})

import type { LanguageFn } from 'lowlight';
import type { CodeGrammar } from './code-languages.ts';

/**
 * Each grammar's own import, so the build puts each in a chunk of its own,
 * fetched the first time a shown block is in its language (#265). None is in
 * the start-up bundle. The app wraps these in its chunks (`code-languages.ts`
 * in apps/desktop), which recover from a failed load.
 */
export const CODE_GRAMMAR_IMPORTS: Readonly<
  Record<CodeGrammar, () => Promise<{ default: LanguageFn }>>
> = {
  bash: () => import('highlight.js/lib/languages/bash'),
  css: () => import('highlight.js/lib/languages/css'),
  json: () => import('highlight.js/lib/languages/json'),
  markdown: () => import('highlight.js/lib/languages/markdown'),
  python: () => import('highlight.js/lib/languages/python'),
  rust: () => import('highlight.js/lib/languages/rust'),
  sql: () => import('highlight.js/lib/languages/sql'),
  typescript: () => import('highlight.js/lib/languages/typescript'),
  xml: () => import('highlight.js/lib/languages/xml'),
  yaml: () => import('highlight.js/lib/languages/yaml'),
};

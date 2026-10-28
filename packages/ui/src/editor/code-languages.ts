import { createLowlight, type LanguageFn } from 'lowlight';

/*
 * The languages a code block is highlighted in, each grammar loaded the first
 * time a shown block names it (#265). Until then the block is its plain text,
 * which the highlighting only colours: nothing moves when it arrives.
 */

/** Every grammar a code block can be highlighted with. */
export const CODE_GRAMMARS = [
  'bash',
  'css',
  'json',
  'markdown',
  'python',
  'rust',
  'sql',
  'typescript',
  'xml',
  'yaml',
] as const;

export type CodeGrammar = (typeof CODE_GRAMMARS)[number];

/**
 * The names a fence may give each grammar. Known before the grammar loads, so
 * a block can ask for the one it needs; a grammar's own aliases would only be
 * known once it had. JavaScript is read with the TypeScript grammar, a superset.
 */
const NAMES: Readonly<Record<CodeGrammar, readonly string[]>> = {
  bash: ['bash', 'sh', 'shell', 'zsh'],
  css: ['css'],
  json: ['json', 'jsonc', 'json5'],
  markdown: ['markdown', 'md', 'mkd', 'mkdown'],
  python: ['python', 'py', 'gyp', 'ipython'],
  rust: ['rust', 'rs'],
  sql: ['sql'],
  typescript: ['typescript', 'ts', 'tsx', 'mts', 'cts', 'javascript', 'js', 'jsx', 'mjs', 'cjs'],
  xml: ['xml', 'html', 'xhtml', 'svg', 'rss', 'atom', 'plist', 'xsd', 'xsl', 'xjb', 'wsf'],
  yaml: ['yaml', 'yml'],
};

const GRAMMAR_OF: ReadonlyMap<string, CodeGrammar> = new Map(
  CODE_GRAMMARS.flatMap((grammar) => NAMES[grammar].map((name) => [name, grammar] as const)),
);

/** The grammar a fence's language names, in any case; null for none, or one DFAI does not highlight. */
export function grammarFor(language: string | null | undefined): CodeGrammar | null {
  if (language === null || language === undefined) return null;
  return GRAMMAR_OF.get(language.trim().toLowerCase()) ?? null;
}

/** A block's code as highlighted: a tree of text and the classes that colour it. */
export type HighlightedCode = ReturnType<ReturnType<typeof createLowlight>['highlight']>;

/**
 * Fetches one grammar. `fresh` is set when the last fetch of it failed, so a
 * chunk the browser keeps failed under its address can be asked for under a
 * new one. It reports its own failures; a rejection here only leaves blocks plain.
 */
export type LoadGrammar = (
  grammar: CodeGrammar,
  options: { fresh: boolean },
) => Promise<LanguageFn>;

/** The app's code highlighting: one per app, so each grammar is fetched once for every editor. */
export interface CodeLanguages {
  /** `code` highlighted with `grammar`; null until the grammar has loaded. */
  highlight(grammar: CodeGrammar, code: string): HighlightedCode | null;
  /**
   * Loads `grammar`, or joins the load under way. True once it highlights;
   * false when the load failed, and the next ask tries again afresh.
   */
  load(grammar: CodeGrammar): Promise<boolean>;
  /**
   * Called with each grammar as it arrives, whoever asked for it: an editor
   * whose own load of it failed is coloured when another's succeeds.
   * Returns the way to stop listening.
   */
  onReady(listener: (grammar: CodeGrammar) => void): () => void;
}

export function createCodeLanguages(loadGrammar: LoadGrammar): CodeLanguages {
  const lowlight = createLowlight();
  const pending = new Map<CodeGrammar, Promise<boolean>>();
  const failed = new Set<CodeGrammar>();
  const listeners = new Set<(grammar: CodeGrammar) => void>();

  const fetchOnce = (grammar: CodeGrammar): Promise<boolean> =>
    loadGrammar(grammar, { fresh: failed.has(grammar) }).then(
      (language) => {
        lowlight.register(grammar, language);
        failed.delete(grammar);
        for (const listener of [...listeners]) listener(grammar);
        return true;
      },
      () => {
        // Not kept: the block stays plain, and the next block to ask fetches it again.
        failed.add(grammar);
        return false;
      },
    );

  return {
    highlight: (grammar, code) =>
      lowlight.registered(grammar) ? lowlight.highlight(grammar, code) : null,
    load: (grammar) => {
      if (lowlight.registered(grammar)) return Promise.resolve(true);
      const loading =
        pending.get(grammar) ?? fetchOnce(grammar).finally(() => pending.delete(grammar));
      pending.set(grammar, loading);
      return loading;
    },
    onReady: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

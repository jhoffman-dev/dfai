import { describe, expect, it, vi } from 'vitest';
import typescript from 'highlight.js/lib/languages/typescript';
import yaml from 'highlight.js/lib/languages/yaml';
import type { LanguageFn } from 'lowlight';
import {
  CODE_GRAMMARS,
  createCodeLanguages,
  grammarFor,
  type CodeGrammar,
  type LoadGrammar,
} from './code-languages.ts';

/** #265: each grammar loads once, on first use, by any name a fence gives it. */

const GRAMMARS: Partial<Record<CodeGrammar, LanguageFn>> = { typescript, yaml };

/** A loader that hands over the grammars above at once, counting each fetch. */
function counting(): { load: ReturnType<typeof vi.fn<LoadGrammar>> } {
  return {
    load: vi.fn<LoadGrammar>(async (grammar) => {
      const language = GRAMMARS[grammar];
      if (language === undefined) throw new Error(`no ${grammar} in the test`);
      return language;
    }),
  };
}

const classesOf = (tree: unknown): string[] => JSON.stringify(tree).match(/hljs-[a-z_]+/g) ?? [];

describe('the grammar a fence names', () => {
  it.each([
    ['js', 'typescript'],
    ['javascript', 'typescript'],
    ['ts', 'typescript'],
    ['TypeScript', 'typescript'],
    ['tsx', 'typescript'],
    ['sh', 'bash'],
    ['bash', 'bash'],
    ['zsh', 'bash'],
    ['yml', 'yaml'],
    ['yaml', 'yaml'],
    ['py', 'python'],
    ['rs', 'rust'],
    ['html', 'xml'],
    ['md', 'markdown'],
    [' json ', 'json'],
    ['SQL', 'sql'],
    ['css', 'css'],
  ])('reads %j as %s', (name, grammar) => {
    expect(grammarFor(name)).toBe(grammar);
  });

  it('is none for a language DFAI does not highlight, or no language at all', () => {
    expect(grammarFor('cobol')).toBeNull();
    expect(grammarFor('')).toBeNull();
    expect(grammarFor(null)).toBeNull();
    expect(grammarFor(undefined)).toBeNull();
  });

  it('is named for every grammar there is', () => {
    for (const grammar of CODE_GRAMMARS) expect(grammarFor(grammar)).toBe(grammar);
  });
});

describe('loading a grammar on first use', () => {
  it('highlights nothing until the grammar has loaded, then colours the code', async () => {
    const { load } = counting();
    const languages = createCodeLanguages(load);
    expect(languages.highlight('typescript', 'const kale = 55;')).toBeNull();
    expect(load).not.toHaveBeenCalled();

    await expect(languages.load('typescript')).resolves.toBe(true);
    expect(classesOf(languages.highlight('typescript', 'const kale = 55;'))).toEqual(
      expect.arrayContaining(['hljs-keyword', 'hljs-number']),
    );
  });

  it('fetches each grammar once, however many blocks ask at once or later', async () => {
    const { load } = counting();
    const languages = createCodeLanguages(load);
    const asked = await Promise.all([
      languages.load('typescript'),
      languages.load('typescript'),
      languages.load('yaml'),
    ]);
    await languages.load('typescript');
    expect(asked).toEqual([true, true, true]);
    expect(load.mock.calls.map(([grammar]) => grammar)).toEqual(['typescript', 'yaml']);
  });

  it('leaves the code plain when the load fails, and fetches it afresh when asked again', async () => {
    const load = vi
      .fn<LoadGrammar>()
      .mockRejectedValueOnce(new Error('Importing a module script failed.'))
      .mockResolvedValueOnce(typescript);
    const languages = createCodeLanguages(load);

    await expect(languages.load('typescript')).resolves.toBe(false);
    expect(languages.highlight('typescript', 'let a = 1;')).toBeNull();

    await expect(languages.load('typescript')).resolves.toBe(true);
    expect(load.mock.calls).toEqual([
      ['typescript', { fresh: false }],
      ['typescript', { fresh: true }],
    ]);
    expect(classesOf(languages.highlight('typescript', 'let a = 1;'))).toContain('hljs-keyword');
  });

  it('keeps asking afresh while a grammar keeps failing, without fetching twice at once', async () => {
    const load = vi.fn<LoadGrammar>().mockRejectedValue(new Error('offline'));
    const languages = createCodeLanguages(load);
    await languages.load('yaml');
    await expect(Promise.all([languages.load('yaml'), languages.load('yaml')])).resolves.toEqual([
      false,
      false,
    ]);
    expect(load.mock.calls).toEqual([
      ['yaml', { fresh: false }],
      ['yaml', { fresh: true }],
    ]);
  });

  it('keeps each app’s grammars its own', async () => {
    const one = createCodeLanguages(counting().load);
    const other = createCodeLanguages(counting().load);
    await one.load('yaml');
    expect(one.highlight('yaml', 'a: 1')).not.toBeNull();
    expect(other.highlight('yaml', 'a: 1')).toBeNull();
  });

  it('tells each listener of every grammar as it arrives, until it stops listening', async () => {
    const languages = createCodeLanguages(counting().load);
    const heard: CodeGrammar[] = [];
    const stop = languages.onReady((grammar) => heard.push(grammar));
    await languages.load('yaml');
    await languages.load('yaml');
    stop();
    await languages.load('typescript');
    expect(heard).toEqual(['yaml']);
  });

  it('tells no listener of a grammar that failed to load', async () => {
    const languages = createCodeLanguages(
      vi.fn<LoadGrammar>().mockRejectedValue(new Error('offline')),
    );
    const heard: CodeGrammar[] = [];
    languages.onReady((grammar) => heard.push(grammar));
    await languages.load('yaml');
    expect(heard).toEqual([]);
  });
});

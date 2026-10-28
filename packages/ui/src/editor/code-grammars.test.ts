import { describe, expect, it } from 'vitest';
import { CODE_GRAMMAR_IMPORTS } from './code-grammars.ts';
import { CODE_GRAMMARS, createCodeLanguages } from './code-languages.ts';

/** #265: every grammar a fence can name has an import, and each highlights its own language. */

describe('the grammars loaded on first use', () => {
  it('has one import for each grammar, and no other', () => {
    expect(Object.keys(CODE_GRAMMAR_IMPORTS).sort()).toEqual([...CODE_GRAMMARS].sort());
  });

  it.each(CODE_GRAMMARS)('loads %s, which then highlights', async (grammar) => {
    const languages = createCodeLanguages(
      async (name) => (await CODE_GRAMMAR_IMPORTS[name]()).default,
    );
    await expect(languages.load(grammar)).resolves.toBe(true);
    expect(languages.highlight(grammar, 'x')).not.toBeNull();
  });
});

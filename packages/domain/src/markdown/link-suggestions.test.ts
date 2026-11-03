import { describe, expect, it } from 'vitest';
import {
  linkMatchOf,
  openLinkInText,
  rankLinkChoices,
  withLinkInText,
  type LinkHints,
} from './link-suggestions.ts';

const note = (title: string, extra: { path?: string; type?: string } = {}) => ({
  path: extra.path ?? `projects/${title}.md`,
  title,
  ...(extra.type !== undefined && { type: extra.type }),
});

const hints = ({
  aliases = {},
  uses = {},
}: {
  aliases?: Record<string, readonly string[]>;
  uses?: Record<string, { count: number; last: number | null }>;
}): LinkHints => ({
  aliases: new Map(Object.entries(aliases)),
  uses: new Map(Object.entries(uses)),
});

const titles = (query: string, choices: ReturnType<typeof note>[], given?: LinkHints) =>
  rankLinkChoices({ query, choices, ...(given !== undefined && { hints: given }) }).map(
    (each) => each.choice.title,
  );

describe('linkMatchOf', () => {
  it('tells an exact name from a prefix, a word, a part and a fuzzy match', () => {
    expect(linkMatchOf('Larkspur Payroll', 'larkspur payroll')).toBe('exact');
    expect(linkMatchOf('Larkspur Payroll', 'lark')).toBe('prefix');
    expect(linkMatchOf('Larkspur Payroll', 'pay')).toBe('word');
    expect(linkMatchOf('Larkspur Payroll', 'spur')).toBe('contains');
    expect(linkMatchOf('Larkspur Payroll', 'lkpr')).toBe('fuzzy');
    expect(linkMatchOf('Larkspur Payroll', 'zebra')).toBeNull();
  });

  it('ignores case and accents, however the accent is spelt', () => {
    expect(linkMatchOf('Zoë Ashby', 'zoe')).toBe('prefix');
    expect(linkMatchOf('Zoë Ashby', 'ZOË')).toBe('prefix');
    expect(linkMatchOf('Café Plans', 'cafe plans')).toBe('exact');
  });

  it('counts a word after punctuation as a word', () => {
    expect(linkMatchOf('Q3-roadmap', 'road')).toBe('word');
    expect(linkMatchOf('Mara (Quill)', 'quill')).toBe('word');
  });

  it('offers a fuzzy match only from three letters, which most names would otherwise meet', () => {
    expect(linkMatchOf('Plan the offsite', 'to')).toBeNull();
    expect(linkMatchOf('Plan the offsite', 'pto')).toBe('fuzzy');
  });

  it('matches anything when nothing is typed', () => {
    expect(linkMatchOf('Anything', '   ')).toBe('any');
  });
});

describe('rankLinkChoices', () => {
  it('ranks an exact name, then a prefix, then a word, then a part, then fuzzy', () => {
    const choices = [
      note('Garden shed'),
      note('Spring garden'),
      note('Garden'),
      note('Regarden'),
      note('Grand Arden'),
    ];
    expect(titles('garden', choices)).toEqual([
      'Garden',
      'Garden shed',
      'Spring garden',
      'Regarden',
      'Grand Arden',
    ]);
  });

  it('drops what does not match at all', () => {
    expect(titles('mara', [note('Mara Quill'), note('Tobias Fenn')])).toEqual(['Mara Quill']);
  });

  it('matches an alias, and says which alias matched', () => {
    const choices = [note('Tobias Fenn'), note('Mara Quill')];
    const given = hints({ aliases: { 'projects/Mara Quill.md': ['MQ', 'Mara'] } });
    const ranked = rankLinkChoices({ query: 'mq', choices, hints: given });
    expect(ranked.map((each) => [each.choice.title, each.alias])).toEqual([['Mara Quill', 'MQ']]);
  });

  it('names no alias when the title matched as well as the alias did', () => {
    const given = hints({ aliases: { 'projects/Mara Quill.md': ['Mara Q'] } });
    const [first] = rankLinkChoices({ query: 'mara', choices: [note('Mara Quill')], hints: given });
    expect(first?.alias).toBeNull();
  });

  it('takes the better of title and alias', () => {
    const choices = [note('Payroll migration'), note('Larkspur onboarding')];
    const given = hints({ aliases: { 'projects/Larkspur onboarding.md': ['Payroll'] } });
    // The alias is exact; the other note's title is only a prefix.
    expect(titles('payroll', choices, given)).toEqual(['Larkspur onboarding', 'Payroll migration']);
  });

  it('puts the recent and the often-used first among equal matches', () => {
    const choices = [note('Alpha'), note('Apex'), note('Atlas')];
    const given = hints({
      uses: {
        'projects/Atlas.md': { count: 1, last: 300 },
        'projects/Apex.md': { count: 9, last: 300 },
        'projects/Alpha.md': { count: 50, last: 100 },
      },
    });
    expect(titles('a', choices, given)).toEqual(['Apex', 'Atlas', 'Alpha']);
  });

  it('ranks a use the index cannot date after every dated one, never first (ADR-0053)', () => {
    const choices = [note('Alpha'), note('Apex'), note('Atlas')];
    const given = hints({
      uses: {
        'projects/Alpha.md': { count: 50, last: null },
        'projects/Apex.md': { count: 1, last: 100 },
      },
    });
    expect(titles('a', choices, given)).toEqual(['Apex', 'Alpha', 'Atlas']);
  });

  it('never lets use outrank a better match', () => {
    const choices = [note('Plan'), note('Replanting')];
    const given = hints({ uses: { 'projects/Replanting.md': { count: 99, last: 999 } } });
    expect(titles('plan', choices, given)).toEqual(['Plan', 'Replanting']);
  });

  it('lists everything, most used first, when nothing is typed', () => {
    const choices = [note('Beta'), note('Alpha'), note('Gamma')];
    const given = hints({ uses: { 'projects/Gamma.md': { count: 2, last: 5 } } });
    expect(titles('', choices, given)).toEqual(['Gamma', 'Alpha', 'Beta']);
  });

  it('prefers the shorter of two prefix matches, then the alphabet, then the path', () => {
    const choices = [
      note('Garden shed', { path: 'b/Garden shed.md' }),
      note('Garden', { path: 'b/Garden.md' }),
      note('Garden', { path: 'a/Garden.md' }),
    ];
    expect(rankLinkChoices({ query: 'gar', choices }).map((each) => each.choice.path)).toEqual([
      'a/Garden.md',
      'b/Garden.md',
      'b/Garden shed.md',
    ]);
  });

  it('stops at the limit', () => {
    const choices = Array.from({ length: 30 }, (_, at) => note(`Note ${String(at).padStart(2)}`));
    expect(rankLinkChoices({ query: 'note', choices, limit: 5 })).toHaveLength(5);
  });

  it('keeps what a choice carries, such as its type', () => {
    const [first] = rankLinkChoices({ query: 'gar', choices: [note('Garden', { type: 'area' })] });
    expect(first?.choice.type).toBe('area');
    expect(first?.match).toBe('prefix');
  });
});

describe('a link typed into text', () => {
  it('finds the half-typed link the caret is in', () => {
    expect(openLinkInText('See [[Mar', 9)).toEqual({ start: 4, query: 'Mar' });
    expect(openLinkInText('[[', 2)).toEqual({ start: 0, query: '' });
  });

  it('finds none once the link is closed, or with no [[ before the caret', () => {
    expect(openLinkInText('[[Mara]] and', 12)).toBeNull();
    expect(openLinkInText('plain text', 5)).toBeNull();
    expect(openLinkInText('[[Mara]]', 4)).toEqual({ start: 0, query: 'Ma' });
  });

  it('finds none across a line break or a second [[', () => {
    expect(openLinkInText('[[Ma\nra', 7)).toBeNull();
    expect(openLinkInText('[[a [[Tob', 9)).toEqual({ start: 4, query: 'Tob' });
  });

  it('puts the picked link in place of what was typed, and the caret after it', () => {
    expect(withLinkInText({ text: 'See [[Mar', caret: 9, link: '[[Mara Quill]]' })).toEqual({
      text: 'See [[Mara Quill]]',
      caret: 18,
    });
  });

  it('replaces a closing ]] already there rather than doubling it', () => {
    expect(withLinkInText({ text: '[[Ma]] then', caret: 4, link: '[[Mara Quill]]' })).toEqual({
      text: '[[Mara Quill]] then',
      caret: 14,
    });
  });

  it('takes in a lone ] after the caret rather than leave a third one', () => {
    expect(withLinkInText({ text: '[[Gar]', caret: 5, link: '[[Garden]]' })).toEqual({
      text: '[[Garden]]',
      caret: 10,
    });
  });

  it('drops a [ typed once too often before the link', () => {
    expect(openLinkInText('See [[[Gar', 10)).toEqual({ start: 4, query: 'Gar' });
    expect(withLinkInText({ text: 'See [[[Gar', caret: 10, link: '[[Garden]]' }).text).toBe(
      'See [[Garden]]',
    );
  });

  it('leaves the text alone when there is no half-typed link', () => {
    expect(withLinkInText({ text: 'plain', caret: 5, link: '[[X]]' })).toEqual({
      text: 'plain',
      caret: 5,
    });
  });
});

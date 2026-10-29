import { describe, expect, it } from 'vitest';
import { linkifyPhrasing, linkifyWords } from './capture-linkify.ts';
import { MAX_MESSAGE_LENGTH } from './capture-payload.ts';
import { text } from './capture-tree.ts';

/*
 * Every address GFM could read in a text node's words, made a link (#103,
 * third attack on PR #615), in work linear in the words.
 */

const pieces = (value: string) =>
  linkifyWords(value).pieces.map((piece) =>
    piece.type === 'text' ? piece.value : `[${piece.url}]`,
  );

describe('linkifyWords: the addresses in a text node’s words', () => {
  it.each([
    [
      'a web address, cut before its trailing punctuation',
      'see https://example.com/a.',
      ['see ', '[https://example.com/a]', '.'],
    ],
    [
      'a ) the address opened',
      'https://example.com/a_(b))',
      ['[https://example.com/a_%28b%29]', ')'],
    ],
    ['www., given its scheme', 'www.example.com', ['[http://www.example.com]']],
    [
      'an address run on to the next space, as GFM runs it',
      'www.]x/[[y now',
      ['[http://www.%5Dx/%5B%5By]', ' now'],
    ],
    ['a mail address', 'to mara@example.com.', ['to ', '[mailto:mara@example.com]', '.']],
    [
      'a mail address after letters beyond ASCII',
      'émara@example.com',
      ['é', '[mailto:mara@example.com]'],
    ],
    ['two addresses', 'a@b.co https://c.example', ['[mailto:a@b.co]', ' ', '[https://c.example]']],
  ])('links %s', (_, value, expected) => {
    expect(pieces(value)).toEqual(expected);
  });

  it.each([
    ['a scheme with nothing after it', 'https:// x'],
    ['a mail address with no dotted domain', 'mara@example'],
    ['a mail domain ending in `-`', 'mara@example.co-'],
    ['an `@` alone', 'a @ b'],
  ])('leaves %s as words', (_, value) => {
    expect(pieces(value).every((piece) => !piece.startsWith('['))).toBe(true);
  });

  it('links www. with any domain to an absolute address, as GFM’s widest reading would', () => {
    expect(pieces('www._ now')).toEqual(['[http://www._]', ' now']);
  });

  it('never links into a link, and joins the words beside each other first', () => {
    const phrasing = linkifyPhrasing([
      text('mail mara'),
      text('@example.com'),
      { type: 'link', url: 'https://x.example', title: null, children: [text('www.example.com')] },
    ]);
    expect(phrasing.map((node) => node.type)).toEqual(['text', 'link', 'link']);
    expect(phrasing[2]).toMatchObject({ children: [text('www.example.com')] });
  });

  it.each([
    ['letters', 'a'],
    ['names ending in dots before no `@`', 'a.'],
    ['www. after www.', 'www.'],
    ['schemes', 'http://'],
    ['closing parentheses after an address', 'https://x)'],
    ['@ after names', 'a.b@'],
  ])('does work linear in words of %s at Slack’s length', (_, unit) => {
    const value = unit.repeat(Math.ceil(MAX_MESSAGE_LENGTH / unit.length));
    expect(linkifyWords(value).steps).toBeLessThanOrEqual(8 * value.length);
  });
});

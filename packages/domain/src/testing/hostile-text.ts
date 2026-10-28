/*
 * Text an attacker would send through a capture (#103): frontmatter fences,
 * headings, tags, wiki links, embeds, block ids, HTML, fences, tables,
 * entities, bare addresses, control and direction characters, half
 * surrogates. Joined at random from a seed, so a failing case is found again
 * by its seed. Test support only.
 */

/** Mulberry32: a small seeded generator of numbers in [0, 1). */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const HOSTILE_PIECES: readonly string[] = [
  '---',
  '\n---\n',
  '\n',
  '\n\n',
  ' ',
  '# ',
  '#tag',
  '## Thread',
  '[[Secret]]',
  '![[Secret]]',
  '![x](https://example.com/p.png)',
  '^t0001',
  ' ^m1793136000-000100',
  '<script>alert(1)</script>',
  '&lt;b&gt;',
  '&lt;img src=x&gt;',
  '&amp;lt;',
  '&#60;',
  '&nbsp;',
  '```',
  '```atlas-query\n',
  '`',
  '~~~',
  '| a | b |\n|---|---|',
  '> ',
  '&gt; ',
  '\\',
  '*',
  '_',
  '~',
  '*bold*',
  '_it_',
  '~st~',
  '<@U0TOBIAS22>',
  '<@U0NOBODY99|x>',
  '<#C0LARK5PUR|ops>',
  '<https://example.com|label>',
  '<javascript:alert(1)|x>',
  '<!here>',
  '<!-- x -->',
  '\u0000',
  '\u0007',
  '‮',
  '⁦',
  '\r\n',
  '\r',
  ' ',
  '\uD800',
  '\uDC00',
  '﻿',
  '%%',
  '==',
  '$$',
  ':tada:',
  "'",
  '"',
  ': ',
  'key: value',
  '- [ ] ',
  '1. ',
  '    code',
  '[!note]',
  'Setext\n===',
  'https://example.com/x',
  'www.example.com',
  'mara@example.com',
  'mailto:x@example.com',
  'é',
  '👨‍👩‍👧',
  'words',
  // From PR #615's review: links whose addresses hold wiki links, delimiter rows, prototype keys.
  '<https://example.com/[[Mara]]|see>',
  '<https://example.com/![[Secret]]>',
  '<mailto:[[Mara]]@example.com>',
  'https://example.com/[[Mara]] ',
  '\n:-',
  '\n:-:',
  '<@constructor>',
  '<@__proto__>',
];

/** Between one and `most` hostile pieces, joined. */
export function hostileText(random: () => number, most: number): string {
  const count = 1 + Math.floor(random() * most);
  return Array.from(
    { length: count },
    () => HOSTILE_PIECES[Math.floor(random() * HOSTILE_PIECES.length)],
  ).join('');
}

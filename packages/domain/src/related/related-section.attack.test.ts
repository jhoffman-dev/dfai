import { describe, expect, it } from 'vitest';
import { wikiLinkSpans } from '../markdown/wikilink-spans.ts';
import { withRelatedLink } from './related-section.ts';

/** mulberry32: a small seeded RNG, so every generated body is the same on every run. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

const FRAGMENTS = [
  'Mara Quill moves payday to Friday.',
  '',
  '## Related',
  '## Related   ',
  '## related ##',
  '### Related',
  'Related',
  '-------',
  '- [[Budget]]',
  '- ## Related',
  '> ## Related',
  '<!-- a note to self -->',
  '    ## Related',
  '```',
  '```ts',
  '~~~',
  '~~~~',
  '````',
  '## Later',
  '# Plan',
  '1. step',
  'Ünïcödé café',
] as const;

/** A hostile body: fragments joined by LF, CRLF or a mix, with or without a final break, maybe a BOM. */
function hostileBody(random: () => number): string {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  const count = Math.floor(random() * 9);
  const breaks = pick([['\n'], ['\r\n'], ['\n', '\r\n']]);
  let body = random() < 0.1 ? '﻿' : '';
  for (let at = 0; at < count; at += 1) {
    body += pick(FRAGMENTS);
    if (at < count - 1 || random() < 0.5) body += pick(breaks);
  }
  return body;
}

const BODIES = (() => {
  const random = seeded(614);
  return Array.from({ length: 2000 }, () => hostileBody(random));
})();

const TARGET = 'Garden';

/** Whether the markdown links `target` with a link the repo's own scanner reads as one. */
const linksTo = (markdown: string, target: string): boolean =>
  wikiLinkSpans(markdown).some((span) => span.link.target === target);

describe('withRelatedLink over seeded hostile bodies', () => {
  it('keeps every byte of the body in place and adds exactly one link to the target', () => {
    for (const body of BODIES) {
      const written = withRelatedLink(body, TARGET);
      if (written === null) continue;
      // Exactly one insertion: a common prefix and a common suffix covering the whole body.
      let prefix = 0;
      while (prefix < body.length && body[prefix] === written[prefix]) prefix += 1;
      const added = written.slice(prefix, written.length - (body.length - prefix));
      expect(written.endsWith(body.slice(prefix)), JSON.stringify(body)).toBe(true);
      expect(added.split(`[[${TARGET}]]`).length - 1, JSON.stringify(body)).toBe(1);
    }
  });

  it('writes nothing the second time the same note is accepted', () => {
    const failures = BODIES.filter((body) => {
      const once = withRelatedLink(body, TARGET);
      return once !== null && withRelatedLink(once, TARGET) !== null;
    });
    expect(failures.slice(0, 3)).toEqual([]);
  });

  it('writes a link the markdown scanner reads as a link, never code or a comment', () => {
    const failures = BODIES.filter((body) => {
      const once = withRelatedLink(body, TARGET);
      return once !== null && !linksTo(once, TARGET);
    });
    expect(failures.slice(0, 3)).toEqual([]);
  });
});

describe('withRelatedLink on bodies its line scan misreads', () => {
  it('never appends the section inside a code block the body leaves open', () => {
    const written = withRelatedLink('Mara Quill\n```\nconst pay = 1;\n', TARGET);
    expect(written).not.toBeNull();
    expect(linksTo(written!, TARGET)).toBe(true);
  });

  it('does not take a backtick line whose info string holds a backtick for a fence', () => {
    // CommonMark: a backtick fence's info string may not contain a backtick, so this is prose.
    const written = withRelatedLink(
      'Mara Quill\n``` pay`day\n\n## Related\n\n- [[Budget]]\n',
      TARGET,
    );
    expect(written).toBe('Mara Quill\n``` pay`day\n\n## Related\n\n- [[Budget]]\n- [[Garden]]\n');
  });

  it('counts a link listed in another Unicode form as already listed', () => {
    // NFD "Café" in the file, NFC from the index: the resolver composes both, so it is one note.
    expect(withRelatedLink('## Related\n\n- [[Café]]\n', 'Café')).toBeNull();
  });

  it('counts a link listed with its .md extension as already listed', () => {
    expect(withRelatedLink('## Related\n\n- [[Garden.md]]\n', TARGET)).toBeNull();
  });
});

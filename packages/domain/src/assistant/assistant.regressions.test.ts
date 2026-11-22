/**
 * Regressions found attacking the assistant tools (#535, P32-04): the domain's
 * quotes, citations and dated items at their edges. Each names the invariant
 * it holds the code to.
 */

import { describe, expect, it } from 'vitest';
import { readWikiLink } from '../markdown/wikilink-spans.ts';
import { meetingTurnsOf } from '../meetings/meeting-turns.ts';
import { createVaultPath, type VaultPath } from '../vault/vault-path.ts';
import {
  linkingAmong,
  noteCitation,
  sourceBlockOf,
  sourceCitation,
  turnCitation,
} from './citation.ts';
import { datedNote } from './assistant-items.ts';
import { ANY_TURN, meetingQuotes, QUOTE_CHARACTERS, type TurnFilter } from './meeting-quotes.ts';

const PATH = createVaultPath('Meetings/Kickoff.md');
const { targetOf, resolve } = linkingAmong([PATH]);
const MARA_ONLY: TurnFilter = { ...ANY_TURN, speakers: ['Mara Quill'] };

const meeting = (turns: readonly string[]): string =>
  ['---', 'type: meeting', '---', '', '## Transcript', '', ...turns.flatMap((t) => [t, ''])].join(
    '\n',
  );

function quotesOf(turns: readonly string[], path: VaultPath = PATH) {
  return meetingQuotes({ path, turns: meetingTurnsOf(meeting(turns)), filter: MARA_ONLY, targetOf })
    .quotes;
}

/** A lone UTF-16 surrogate: half an emoji, which JSON and the model see as garbage. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** A tiny seeded RNG (mulberry32), so the property run is the same every time. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('a quote cut at 400 characters', () => {
  it('never cuts an emoji in half at the 400-character cut', () => {
    const words = `${'a'.repeat(QUOTE_CHARACTERS - 2)}😀 and then the bank file.`;
    const [quote] = quotesOf([`**Mara Quill** [00:00:05] ${words} ^t0001`]);
    expect(quote?.cut).toBe(true);
    expect(quote?.quote).not.toMatch(LONE_SURROGATE);
  });

  it('never drops a combining accent off the last letter it keeps', () => {
    // "é" written decomposed (e + U+0301) straddles the cut: the quote must not say "e".
    const words = `${'a'.repeat(QUOTE_CHARACTERS - 2)}é rest of the turn goes on.`;
    const [quote] = quotesOf([`**Mara Quill** ${words} ^t0001`]);
    expect(quote?.cut).toBe(true);
    const kept = (quote?.quote ?? '').replace(/…$/, '');
    expect(words.startsWith(kept)).toBe(true);
    expect(kept.endsWith('e')).toBe(false);
  });

  it('keeps every cut quote free of lone surrogates (seeded property, 300 runs)', () => {
    const random = seeded(535);
    const alphabet = ['a', ' ', '😀', '𝔸', 'é', 'é', '中', '👩‍👩‍👧'];
    for (let run = 0; run < 300; run += 1) {
      const length = 380 + Math.floor(random() * 60);
      let words = '';
      while (words.length < length) words += alphabet[Math.floor(random() * alphabet.length)];
      const [quote] = quotesOf([`**Mara Quill** x${words}`]);
      expect(quote?.quote ?? '', `run ${run}`).not.toMatch(LONE_SURROGATE);
    }
  });
});

describe('a turn cited by its block', () => {
  it('never cites two different turns by one block link (an ^id written twice in the note)', () => {
    const quotes = quotesOf([
      '**Mara Quill** [00:00:05] The cut-over waits for the bank. ^t0003',
      '**Mara Quill** [00:00:50] And the rollback plan is signed. ^t0003',
    ]);
    expect(quotes).toHaveLength(2);
    const blockLinks = quotes.filter((q) => q.cite.kind === 'block').map((q) => q.cite.link);
    // [[Kickoff#^t0003]] opens the first turn: the second turn's quote would be cited to words it is not.
    expect(new Set(blockLinks).size).toBe(blockLinks.length);
  });
});

describe('links to notes whose names hold link syntax', () => {
  // A link's target holds no `# [ ] |` (ADR-0004): a note named so cannot be linked in DFAI or Obsidian.
  for (const name of ['C# sync', 'Plan | draft', 'Notes [old]']) {
    it(`cites "${name}" by its path, with no link that would open another note`, () => {
      const path = createVaultPath(`Meetings/${name}.md`);
      const linking = linkingAmong([path, PATH]);
      const turn = turnCitation(path, 't0001', linking.targetOf);
      expect(turn).toEqual({ link: null, kind: 'note', path });
      expect(noteCitation(path, linking.targetOf)).toEqual({ link: null, kind: 'note', path });
    });
  }

  it('still links a name that holds a caret, which a target may hold', () => {
    const path = createVaultPath('Meetings/Mara^s 1:1.md');
    const linking = linkingAmong([path, PATH]);
    const link = readWikiLink(turnCitation(path, 't0001', linking.targetOf).link ?? '');
    expect(link).not.toBeNull();
    expect(linking.resolve(link?.target ?? '')).toBe(path);
  });

  it('keeps a heading holding "#" whole when a source cites it', () => {
    const cite = sourceCitation('[[Kickoff#C# migration]]', resolve);
    expect(cite).toEqual({ link: '[[Kickoff#C# migration]]', kind: 'heading', path: PATH });
  });
});

describe('a source naming a block', () => {
  const held = ({ id }: { id: string }) => id === 't0003';

  it('cites the block while the index holds it', () => {
    expect(sourceCitation('[[Kickoff#^t0003]]', resolve, held)).toEqual({
      link: '[[Kickoff#^t0003]]',
      kind: 'block',
      path: PATH,
    });
  });

  it('cites the note once the block is gone, never promising a block that is not there', () => {
    expect(sourceCitation('[[Kickoff#^t0099]]', resolve, held)).toEqual({
      link: '[[Kickoff]]',
      kind: 'note',
      path: PATH,
    });
  });

  it('cites the note for a block of a note the vault does not hold', () => {
    expect(sourceCitation('[[Nowhere#^t0003]]', resolve, held)).toEqual({
      link: '[[Nowhere]]',
      kind: 'note',
      path: null,
    });
  });

  it('names the block a source asks the index about, only for a note the vault holds', () => {
    expect(sourceBlockOf('[[Kickoff#^t0003]]', resolve)).toEqual({ path: PATH, id: 't0003' });
    expect(sourceBlockOf('[[Kickoff#Plans]]', resolve)).toBeNull();
    expect(sourceBlockOf('[[Nowhere#^t0003]]', resolve)).toBeNull();
    expect(sourceBlockOf('not a link', resolve)).toBeNull();
  });
});

describe('a meeting dated a day the calendar does not have', () => {
  const row = (date: string) => ({
    path: 'Meetings/Kickoff.md',
    title: 'Kickoff',
    values: { date },
  });
  const context = {
    ...linkingAmong([PATH]),
    sources: new Map<string, string>(),
    hasBlock: () => true,
    day: '2999-03-13',
    time: null,
  };

  for (const date of ['2999-02-30', '2999-13-01', '2999-00-10']) {
    it(`reads ${date} as undated, not as a day to sort and filter by`, () => {
      expect(datedNote(row(date) as never, context).date).toBeNull();
    });
  }
});

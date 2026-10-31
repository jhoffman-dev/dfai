/**
 * The pager behind atlas_read_note (#415) at its edges: properties that leave
 * no room for the body, and where a page may end.
 */

import { describe, expect, it } from 'vitest';
import { cleanEnd, NOTE_READ_CHARACTERS, notePageAnswer } from './note-page.ts';

interface Paged {
  note: { body: string };
  page?: { offset: number; shown: number; next: number | null };
  cut?: unknown;
}

const answerOf = (body: string, properties: Record<string, unknown> = {}) => ({
  note: {
    path: 'Logbook.md',
    title: 'Logbook',
    modified: '2026-10-19T09:00:00Z',
    properties,
    body,
  },
});

const read = (answer: ReturnType<typeof answerOf>, offset: number) => {
  const result = notePageAnswer(answer, offset);
  expect(result.isError).toBe(false);
  expect(result.content.length).toBeLessThanOrEqual(NOTE_READ_CHARACTERS);
  return JSON.parse(result.content) as Paged;
};

describe('a note whose properties leave no room for its body', () => {
  // 0.8 s on a Mac, up to 3.2 s on a loaded 4-core CI runner (#648): the default 5 s is too close.
  it('never answers an empty page that points back at itself', () => {
    const body = 'x'.repeat(2_000);
    // Every size of properties across the last few hundred characters of room.
    for (let pad = NOTE_READ_CHARACTERS - 700; pad <= NOTE_READ_CHARACTERS; pad += 1) {
      const answer = read(answerOf(body, { pad: 'p'.repeat(pad) }), 0);
      if (answer.page === undefined) {
        expect(answer.cut).toBeDefined();
        continue;
      }
      expect(answer.page.shown).toBeGreaterThan(0);
      expect(answer.page.next).not.toBe(answer.page.offset);
    }
  }, 15_000);
});

describe('where a page ends', () => {
  it('at the line break in its second half, so it does not end mid-line', () => {
    const body = `${'x'.repeat(60_000)}\n${'y'.repeat(60_000)}`;

    const first = read(answerOf(body), 0);

    expect(first.page).toMatchObject({ shown: 60_001, next: 60_001 });
    expect(first.note.body.endsWith('x\n')).toBe(true);
  });

  it('never between the two halves of a character, in a body with no line breaks', () => {
    const body = '\u{1F30A}'.repeat(60_000);
    let offset: number | null = 0;
    let read_ = '';
    while (offset !== null) {
      const answer = read(answerOf(body), offset);
      expect(answer.note.body).not.toMatch(/[\uD800-\uDBFF]$/);
      expect(answer.note.body).not.toMatch(/^[\uDC00-\uDFFF]/);
      read_ += answer.note.body;
      offset = answer.page?.next ?? null;
    }
    expect(read_).toBe(body);
  });

  it('keeps nothing rather than half a character when only one unit would fit', () => {
    expect(cleanEnd('\u{1F30A}tide', 0, 1)).toBe(0);
    expect(cleanEnd('\u{1F30A}tide', 0, 2)).toBe(2);
  });

  it('keeps a lone half that pairs with nothing, since cutting it splits nothing', () => {
    expect(cleanEnd('\uD83Dxtide', 0, 1)).toBe(1);
  });
});

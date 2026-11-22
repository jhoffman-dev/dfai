import { describe, expect, it } from 'vitest';
import { indexablePropertiesOf, isDateLike, toIndexableProperties } from './property-value.ts';

const one = (key: string, value: unknown) => toIndexableProperties(key, value)[0];

describe('toIndexableProperties', () => {
  it('keeps a string as text', () => {
    expect(one('status', 'draft')).toMatchObject({ text: 'draft', number: null, date: null });
  });

  it('records a number in both forms', () => {
    expect(one('arr', 1500000)).toMatchObject({ text: '1500000', number: 1500000 });
  });

  it('treats a numeric string as a number too', () => {
    expect(one('count', '42')).toMatchObject({ text: '42', number: 42 });
  });

  it('records a boolean as text', () => {
    expect(one('done', true)).toMatchObject({ text: 'true', number: null });
  });

  it('recognises an ISO date', () => {
    expect(one('due', '2026-09-20')).toMatchObject({ text: '2026-09-20', date: '2026-09-20' });
  });

  it('recognises a date and time', () => {
    expect(one('at', '2026-09-20T14:30:00Z')).toMatchObject({ date: '2026-09-20T14:30:00Z' });
  });

  it.each(['not a date', '2026', '20-09-2026', '2026-13-45'])(
    'leaves %j as plain text',
    (value) => {
      expect(one('field', value)?.date).toBeNull();
    },
  );

  it('handles a Date object from the parser', () => {
    const value = new Date('2026-09-20T00:00:00Z');
    expect(one('due', value)).toMatchObject({ date: '2026-09-20T00:00:00.000Z' });
  });

  it('records null as an empty row, so the key is still known', () => {
    expect(one('empty', null)).toMatchObject({ key: 'empty', text: null, json: null });
  });

  it('keeps a nested object whole as json', () => {
    expect(one('meta', { a: 1 })).toMatchObject({ json: '{"a":1}' });
  });

  it('turns a list into one numbered row per item', () => {
    expect(toIndexableProperties('tags', ['project', 'atlas'])).toEqual([
      { key: 'tags', index: 0, text: 'project', number: null, date: null, json: null },
      { key: 'tags', index: 1, text: 'atlas', number: null, date: null, json: null },
    ]);
  });

  it('numbers a list of mixed values', () => {
    const rows = toIndexableProperties('mixed', [1, 'two']);
    expect(rows.map((row) => [row.index, row.text, row.number])).toEqual([
      [0, '1', 1],
      [1, 'two', null],
    ]);
  });

  it('returns nothing for an empty list', () => {
    expect(toIndexableProperties('tags', [])).toEqual([]);
  });

  it('does not treat infinity as a number the database can hold', () => {
    expect(one('weird', Number.POSITIVE_INFINITY)?.number).toBeNull();
  });
});

describe('isDateLike', () => {
  it.each(['2026-09-20', '2026-09-20T14:30', '2026-09-20 14:30:00', '2026-09-20T14:30:00Z'])(
    'accepts %j',
    (value) => {
      expect(isDateLike(value)).toBe(true);
    },
  );

  it.each(['2026-02-30', 'yesterday', '2026/09/20', ''])('rejects %j', (value) => {
    expect(isDateLike(value)).toBe(false);
  });
});

describe('indexablePropertiesOf', () => {
  it('flattens a whole frontmatter block', () => {
    const rows = indexablePropertiesOf({
      title: 'Today',
      tags: ['daily', 'work'],
      due: '2026-09-20',
      done: false,
    });
    expect(rows.map((row) => row.key)).toEqual(['title', 'tags', 'tags', 'due', 'done']);
  });

  it('returns nothing for empty frontmatter', () => {
    expect(indexablePropertiesOf({})).toEqual([]);
  });
});

describe('the rows a list is read from (#923)', () => {
  // `type-view.ts` reads a list of text's items as its rows of non-blank text;
  // main read its held rows, COALESCE(text, json, '') <> ''. The two pick the
  // same items whatever a row holds, and this writer adds a rule on top that
  // the index's own tests lean on: a row with json has no text, and text is
  // trimmed. A writer that broke it should fail here first.
  const VALUES: unknown[] = [
    'Mara Quill',
    '  padded  ',
    '',
    ' ',
    '2026-03-01',
    ' 7 ',
    7,
    Number.NaN,
    true,
    null,
    { name: 'Mara Quill' },
    [['a', 'b'], { name: 'c' }, ''],
    new Date(Date.UTC(2026, 2, 1)),
  ];

  it.each(VALUES.map((value) => [JSON.stringify(value) ?? String(value), value]))(
    '%s: no text beside json, and text trimmed',
    (_, value) => {
      for (const row of toIndexableProperties('people', value)) {
        if (row.json !== null) expect(row.text).toBeNull();
        if (row.text !== null) expect(row.text).toBe(row.text.trim());
      }
    },
  );
});

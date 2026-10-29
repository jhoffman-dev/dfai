import { describe, expect, it } from 'vitest';
import { SHIPPED_PROPERTIES, type ShippedPropertiesRecord } from '../types/shipped-properties.ts';
import {
  extrasDfaiWrote,
  jsonHasDuplicateKeys,
  liveExtras,
  recordExtrasShipped,
} from './settled-copy.ts';

const kind = (name: string) => ({ kind: name });

describe('liveExtras (#235)', () => {
  it('is every path the live file has and the copy lacks, at any depth', () => {
    expect(
      liveExtras({
        live: {
          name: 'meeting',
          icon: 'x',
          display: { icon: 'cal', color: 'blue' },
          properties: { date: kind('date'), p: kind('text'), q: kind('text') },
        },
        copy: { name: 'meeting', display: { icon: 'cal' }, properties: { date: kind('date') } },
      }),
    ).toEqual([['icon'], ['display', 'color'], ['properties', 'p'], ['properties', 'q']]);
  });

  it('finds what a nested map lacks however deep: an automation, a view, the settings', () => {
    expect(
      liveExtras({
        live: { when: { type: 'task', status: 'done' } },
        copy: { when: { type: 'task' } },
      }),
    ).toEqual([['when', 'status']]);
    expect(
      liveExtras({
        live: { filters: { status: { is: 'next' }, owner: { is: 'me' } } },
        copy: { filters: { status: { is: 'next' } } },
      }),
    ).toEqual([['filters', 'owner']]);
    expect(
      liveExtras({
        live: { a: { b: { c: { d: 1, e: 2 } } } },
        copy: { a: { b: { c: { d: 1 } } } },
      }),
    ).toEqual([['a', 'b', 'c', 'e']]);
    expect(
      liveExtras({
        live: { properties: { date: { kind: 'date', label: 'Date' } } },
        copy: { properties: { date: { kind: 'date' } } },
      }),
    ).toEqual([['properties', 'date', 'label']]);
  });

  it('is nothing when the copy has all the live file has', () => {
    expect(
      liveExtras({
        live: { name: 'meeting', sync: { auto: true }, properties: { date: kind('date') } },
        copy: {
          name: 'meeting',
          label: 'Meeting',
          sync: { auto: true, every: 5 },
          properties: { date: kind('date'), p: kind('text') },
        },
      }),
    ).toEqual([]);
  });

  it('counts a value that is a map on one side and not the other, or differs, as the live file’s', () => {
    expect(liveExtras({ live: { properties: { date: kind('date') } }, copy: {} })).toEqual([
      ['properties'],
    ]);
    expect(
      liveExtras({ live: { properties: { date: kind('date') } }, copy: { properties: ['date'] } }),
    ).toEqual([['properties']]);
    expect(liveExtras({ live: { limit: 5 }, copy: { limit: 6 } })).toEqual([['limit']]);
  });
});

describe('extrasDfaiWrote (#235)', () => {
  it('holds when every extra is a whole property DFAI records adding to the type', () => {
    expect(extrasDfaiWrote({ extras: [['properties', 'q']], added: ['q', 'r'] })).toBe(true);
    expect(extrasDfaiWrote({ extras: [], added: [] })).toBe(true);
  });

  it('fails for a property DFAI did not add, a key inside one, any other path, or a top-level key', () => {
    expect(
      extrasDfaiWrote({
        extras: [
          ['properties', 'p'],
          ['properties', 'q'],
        ],
        added: ['q'],
      }),
    ).toBe(false);
    expect(extrasDfaiWrote({ extras: [['properties', 'q', 'label']], added: ['q'] })).toBe(false);
    expect(extrasDfaiWrote({ extras: [['display', 'q']], added: ['q'] })).toBe(false);
    expect(extrasDfaiWrote({ extras: [['icon']], added: ['icon'] })).toBe(false);
  });
});

describe('recordExtrasShipped (#235)', () => {
  const shipped = SHIPPED_PROPERTIES.get('meeting')!.map((property) => property.key);
  const record = (settled: string[], added: string[] = []): ShippedPropertiesRecord => ({
    settled: { meeting: settled },
    added: added.length === 0 ? {} : { meeting: added },
  });

  it('holds when every key the live record has beyond the copy is one DFAI ships on that type', () => {
    expect(
      recordExtrasShipped({
        live: record(shipped, [shipped[0]!]),
        copy: record([shipped[1]!]),
        shipped: SHIPPED_PROPERTIES,
      }),
    ).toBe(true);
  });

  it('fails for a key DFAI does not ship on that type, or a type it ships nothing on', () => {
    expect(
      recordExtrasShipped({
        live: record([...shipped, 'venue']),
        copy: record(shipped),
        shipped: SHIPPED_PROPERTIES,
      }),
    ).toBe(false);
    expect(
      recordExtrasShipped({
        live: { settled: { meeting: shipped, recipe: ['date'] }, added: {} },
        copy: record(shipped),
        shipped: SHIPPED_PROPERTIES,
      }),
    ).toBe(false);
  });
});

describe('jsonHasDuplicateKeys (#235)', () => {
  it('finds a key named twice in one object, at any depth', () => {
    expect(jsonHasDuplicateKeys('{"a":1,"a":2}')).toBe(true);
    expect(jsonHasDuplicateKeys('{"settled":{"meeting":["x"],"meeting":["y"]},"added":{}}')).toBe(
      true,
    );
    expect(jsonHasDuplicateKeys('[{"a":{"b":1,"b":1}}]')).toBe(true);
    expect(jsonHasDuplicateKeys('{"a":1,"\\u0061":2}')).toBe(true);
  });

  it('is not fooled by the same key in two objects, by values, or by escapes in strings', () => {
    expect(jsonHasDuplicateKeys('{"a":{"a":1},"b":{"a":2}}')).toBe(false);
    expect(jsonHasDuplicateKeys('{"a":"a","b":["a","a"]}')).toBe(false);
    expect(jsonHasDuplicateKeys('{"a\\"":1,"a":2,"x":"{\\"a\\":1,\\"a\\":2}"}')).toBe(false);
    expect(jsonHasDuplicateKeys('[{"a":1},{"a":1}]')).toBe(false);
    expect(jsonHasDuplicateKeys('{}')).toBe(false);
  });

  it('answers true, never throws, for text that is not JSON: it is not a record DFAI wrote', () => {
    for (const broken of ['{"a', '{"a":1,"', '{"\\u00zz":1}', '{"a":1,"a']) {
      expect(jsonHasDuplicateKeys(broken), broken).toBe(true);
    }
  });
});

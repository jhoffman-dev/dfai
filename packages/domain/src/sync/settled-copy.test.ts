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
  it('is the top-level keys and the `properties` entries the live file has and the copy lacks', () => {
    expect(
      liveExtras({
        live: {
          name: 'meeting',
          icon: 'x',
          properties: { date: kind('date'), p: kind('text'), q: kind('text') },
        },
        copy: { name: 'meeting', properties: { date: kind('date') } },
      }),
    ).toEqual({ keys: ['icon'], properties: ['p', 'q'] });
  });

  it('is nothing when the copy has all the live file has', () => {
    expect(
      liveExtras({
        live: { name: 'meeting', properties: { date: kind('date') } },
        copy: {
          name: 'meeting',
          label: 'Meeting',
          properties: { date: kind('date'), p: kind('text') },
        },
      }),
    ).toEqual({ keys: [], properties: [] });
  });

  it('counts `properties` as a key when the copy has none, or it is not a map on either side', () => {
    expect(liveExtras({ live: { properties: { date: kind('date') } }, copy: {} })).toEqual({
      keys: ['properties'],
      properties: [],
    });
    expect(
      liveExtras({ live: { properties: { date: kind('date') } }, copy: { properties: ['date'] } }),
    ).toEqual({ keys: ['properties'], properties: [] });
  });
});

describe('extrasDfaiWrote (#235)', () => {
  it('holds when every extra is a property DFAI records adding to the type', () => {
    expect(extrasDfaiWrote({ extras: { keys: [], properties: ['q'] }, added: ['q', 'r'] })).toBe(
      true,
    );
    expect(extrasDfaiWrote({ extras: { keys: [], properties: [] }, added: [] })).toBe(true);
  });

  it('fails for a property DFAI did not add — one a person took off the copy’s Mac — or any top-level key', () => {
    expect(extrasDfaiWrote({ extras: { keys: [], properties: ['p', 'q'] }, added: ['q'] })).toBe(
      false,
    );
    expect(extrasDfaiWrote({ extras: { keys: ['icon'], properties: [] }, added: ['icon'] })).toBe(
      false,
    );
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
});

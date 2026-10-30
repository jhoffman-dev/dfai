import { describe, expect, it } from 'vitest';
import type { ObjectType, PropertyDef } from './property-def.ts';
import {
  addablePropertyKeys,
  declaredPropertyKeys,
  keysRecorded,
  mergeShippedPropertiesRecords,
  NO_SHIPPED_PROPERTIES_RECORD,
  parseShippedPropertiesRecord,
  PROPERTIES_NOT_A_MAP,
  recordSettling,
  ShippedPropertiesRecordError,
  shippedPropertiesLine,
  shippedPropertiesPlan,
  shippedPropertiesRecordText,
} from './shipped-properties.ts';

const property = (key: string, kind: PropertyDef['kind'] = 'text'): PropertyDef => ({
  key,
  kind,
  label: key,
  required: false,
  options: [],
  target: null,
  many: false,
});

const type = (name: string, keys: readonly string[] = []): ObjectType => ({
  name,
  label: name,
  properties: keys.map((key) => property(key)),
});

const MEETING_KEYS = [
  'atlas_import_outcome',
  'atlas_import_error',
  'atlas_duplicate_of',
  'tasks',
  'decisions',
  'atlas_summary_digest',
  'atlas_summary_of',
  'atlas_summary_model',
];

const parsedKeys = (found: ObjectType) => new Set(found.properties.map((added) => added.key));

const plan = (types: readonly ObjectType[], record = NO_SHIPPED_PROPERTIES_RECORD) =>
  shippedPropertiesPlan(types, record, { declaredKeys: parsedKeys }).changes;

const addedKeys = (types: readonly ObjectType[], record = NO_SHIPPED_PROPERTIES_RECORD) =>
  plan(types, record).map((change) => [change.before.name, change.added.map((added) => added.key)]);

describe('shippedPropertiesPlan', () => {
  it('gives a Meeting type the keys it lacks, after its own', () => {
    const meeting = type('meeting', ['title', 'atlas_import_outcome']);
    const [change] = plan([meeting]);
    expect(change?.after.properties.map((added) => added.key)).toEqual([
      'title',
      'atlas_import_outcome',
      'atlas_import_error',
      'atlas_duplicate_of',
      'tasks',
      'decisions',
      'atlas_summary_digest',
      'atlas_summary_of',
      'atlas_summary_model',
    ]);
  });

  it('keeps a key the type has, whatever its shape', () => {
    const tasks = { ...property('tasks', 'number'), label: 'How many' };
    const meeting: ObjectType = { name: 'meeting', label: 'Meeting', properties: [tasks] };
    const [change] = plan([meeting]);
    expect(change?.after.properties[0]).toBe(tasks);
    expect(change?.added.map((added) => added.key)).not.toContain('tasks');
  });

  it('never adds a settled key again: the person took it off', () => {
    const record = { settled: { meeting: MEETING_KEYS }, added: {} };
    expect(addedKeys([type('meeting', ['title'])], record)).toEqual([]);
  });

  it('adds a key shipped since the type was settled', () => {
    const record = { settled: { meeting: MEETING_KEYS.slice(0, 3) }, added: {} };
    expect(addedKeys([type('meeting', [])], record)).toEqual([
      [
        'meeting',
        ['tasks', 'decisions', 'atlas_summary_digest', 'atlas_summary_of', 'atlas_summary_model'],
      ],
    ]);
  });

  it('adds the summary keys (#185) to a Meeting type settled before they shipped', () => {
    const record = { settled: { meeting: MEETING_KEYS.slice(0, 5) }, added: {} };
    expect(addedKeys([type('meeting', MEETING_KEYS.slice(0, 5))], record)).toEqual([
      ['meeting', ['atlas_summary_digest', 'atlas_summary_of', 'atlas_summary_model']],
    ]);
  });

  it('matches a type by name in any case and spacing', () => {
    expect(addedKeys([type(' Daily ', ['date'])])).toEqual([[' Daily ', ['tags']]]);
  });

  it('lists a complete type with nothing added, so it can be settled; a type of the vault’s own and PARA’s are not listed', () => {
    const complete = type('meeting', MEETING_KEYS);
    const others = [type('recipe'), type('project'), type('Area')];
    expect(addedKeys([complete, ...others])).toEqual([['meeting', []]]);
  });

  it('gives Task `focus` alone (#108), never one of GTD’s keys, nor over a `focus` of its own', () => {
    expect(addedKeys([type('task', ['status'])])).toEqual([['task', ['focus']]]);
    expect(addedKeys([type('task', ['status', 'focus'])])).toEqual([['task', []]]);
  });

  it('does not list a type whose shipped keys are all settled', () => {
    const record = { settled: { meeting: MEETING_KEYS }, added: {} };
    expect(addedKeys([type('meeting', MEETING_KEYS)], record)).toEqual([]);
  });

  it('counts a key the file declares as there even when DFAI could not read it', () => {
    const unread = (found: ObjectType) => new Set([...parsedKeys(found), 'tasks']);
    const [change] = shippedPropertiesPlan([type('meeting')], NO_SHIPPED_PROPERTIES_RECORD, {
      declaredKeys: unread,
    }).changes;
    expect(change?.added.map((added) => added.key)).not.toContain('tasks');
    expect(change?.added.map((added) => added.key)).toContain('decisions');
  });

  it('is not thrown by a type named like an Object.prototype member', () => {
    expect(addedKeys([type('constructor'), type('__proto__'), type('toString')])).toEqual([]);
  });

  it('covers every built-in type of DFAI’s own that it ships properties for, and no PARA type', () => {
    const names = ['proposal', 'decision', 'daily', 'block'];
    const planned = addedKeys(names.map((name) => type(name)));
    expect(planned.map(([name]) => name)).toEqual(names);
    for (const [, keys] of planned) expect(keys).not.toHaveLength(0);
  });
});

describe('shippedPropertiesPlan, on a type it must leave alone', () => {
  it('skips a type whose `properties` is not a map, neither changing nor settling it', () => {
    const notAMap = () => null;
    const meeting = type('meeting');
    const { changes, skipped } = shippedPropertiesPlan([meeting], NO_SHIPPED_PROPERTIES_RECORD, {
      declaredKeys: notAMap,
    });
    expect(changes).toEqual([]);
    expect(skipped).toEqual([{ types: [meeting], label: 'Meeting', reason: PROPERTIES_NOT_A_MAP }]);
  });

  it('skips every file of a type two files claim, and asks for them to be merged', () => {
    const first = type('meeting', ['title']);
    const copy = type(' Meeting ', ['title']);
    const { changes, skipped } = shippedPropertiesPlan(
      [first, copy, type('daily')],
      NO_SHIPPED_PROPERTIES_RECORD,
      { declaredKeys: parsedKeys },
    );
    expect(changes.map((change) => change.before.name)).toEqual(['daily']);
    expect(skipped).toEqual([
      {
        types: [first, copy],
        label: 'Meeting',
        reason:
          'two files say they are the Meeting type: merge them into one, and DFAI will add its properties to it.',
      },
    ]);
  });

  it('says nothing of a duplicated type whose keys are all settled', () => {
    const record = { settled: { meeting: MEETING_KEYS }, added: {} };
    const { skipped } = shippedPropertiesPlan([type('meeting'), type('meeting')], record, {
      declaredKeys: parsedKeys,
    });
    expect(skipped).toEqual([]);
  });
});

describe('keysRecorded', () => {
  it('reads an entry the record has, and nothing for a name it only inherits', () => {
    expect(keysRecorded({ meeting: ['tasks'] }, 'meeting')).toEqual(['tasks']);
    expect(keysRecorded({}, 'constructor')).toEqual([]);
    expect(keysRecorded({}, 'toString')).toEqual([]);
    expect(keysRecorded({ constructor: ['x'] }, 'constructor')).toEqual(['x']);
  });
});

describe('declaredPropertyKeys', () => {
  it('lists the keys a type file declares, trimmed, whatever each one’s shape', () => {
    const declared = declaredPropertyKeys({
      properties: { tasks: 'unheard-of', ' tags ': { kind: 'text' }, '': 'text' },
    });
    expect([...declared]).toEqual(['tasks', 'tags']);
  });

  it('lists nothing for a file whose properties are not a map', () => {
    expect(declaredPropertyKeys({ properties: ['tasks'] })).toEqual(new Set());
    expect(declaredPropertyKeys({})).toEqual(new Set());
  });
});

describe('addablePropertyKeys', () => {
  it('lists the declared keys of a map, and none where there is no map yet', () => {
    expect(addablePropertyKeys({ properties: { ' tasks ': 'text' } })).toEqual(new Set(['tasks']));
    expect(addablePropertyKeys({})).toEqual(new Set());
    expect(addablePropertyKeys({ properties: null })).toEqual(new Set());
  });

  it('is null for `properties` that is a list or a sentence: there is nothing to add beside', () => {
    expect(addablePropertyKeys({ properties: ['tasks'] })).toBeNull();
    expect(addablePropertyKeys({ properties: 'see the Daily note' })).toBeNull();
    expect(addablePropertyKeys({ properties: 3 })).toBeNull();
  });
});

describe('recordSettling', () => {
  it('settles a complete type without recording anything as added', () => {
    const changes = plan([type('meeting', MEETING_KEYS)]);
    expect(recordSettling(NO_SHIPPED_PROPERTIES_RECORD, changes)).toEqual({
      settled: { meeting: MEETING_KEYS },
      added: {},
    });
  });

  it('settles every shipped key of a changed type, the ones it had too, and keeps what was added', () => {
    const changes = plan([type('Meeting', ['atlas_import_outcome'])]);
    const record = recordSettling({ settled: { daily: ['date'] }, added: {} }, changes);
    expect(record).toEqual({
      settled: { daily: ['date'], meeting: MEETING_KEYS },
      added: { meeting: MEETING_KEYS.slice(1) },
    });
  });

  it('adds to what an earlier run settled and added, without repeating a key', () => {
    const earlier = { settled: { meeting: ['tasks'] }, added: { meeting: ['tasks'] } };
    const changes = plan([type('meeting', ['tasks'])], earlier);
    const record = recordSettling(earlier, changes);
    expect(record.settled['meeting']).toEqual([
      'tasks',
      'atlas_import_outcome',
      'atlas_import_error',
      'atlas_duplicate_of',
      'decisions',
      'atlas_summary_digest',
      'atlas_summary_of',
      'atlas_summary_model',
    ]);
    expect(record.added['meeting']).toEqual([
      'tasks',
      'atlas_import_outcome',
      'atlas_import_error',
      'atlas_duplicate_of',
      'decisions',
      'atlas_summary_digest',
      'atlas_summary_of',
      'atlas_summary_model',
    ]);
  });
});

describe('the record file', () => {
  const RECORD = { settled: { meeting: MEETING_KEYS }, added: { meeting: ['tasks'] } };
  // The keys come back sorted: the file is written in one order on every Mac (#233).
  const READ_BACK = {
    settled: { meeting: [...MEETING_KEYS].sort() },
    added: { meeting: ['tasks'] },
  };

  it('reads back what it wrote, under a heading a person can read', () => {
    const text = shippedPropertiesRecordText(RECORD);
    expect(text).toMatch(/^---\natlas: migration\n---\n\n# Properties added to built-in types\n/);
    expect(parseShippedPropertiesRecord(text)).toEqual(READ_BACK);
  });

  it('reads back a record whose line endings were turned to CRLF', () => {
    const text = shippedPropertiesRecordText(RECORD).replace(/\n/g, '\r\n');
    expect(parseShippedPropertiesRecord(text)).toEqual(READ_BACK);
  });

  it('reads a record that says nothing of what was added', () => {
    const text = '---\natlas: migration\n---\n\n```json\n{"settled":{"daily":["tags"]}}\n```\n';
    expect(parseShippedPropertiesRecord(text)).toEqual({
      settled: { daily: ['tags'] },
      added: {},
    });
  });

  it.each([
    ['no list', '---\natlas: migration\n---\n\nNothing here.\n', /no list of keys/],
    ['not JSON', '```json\n{settled\n```\n', /not JSON/],
    ['no settled keys', '```json\n{"added":{}}\n```\n', /which keys are settled/],
    ['keys that are not text', '```json\n{"settled":{"meeting":[1]}}\n```\n', /settled/],
    ['a list for a map', '```json\n{"settled":[]}\n```\n', /settled/],
    ['added that is not keys', '```json\n{"settled":{},"added":{"m":"x"}}\n```\n', /added/],
  ])('refuses a record with %s', (_, text, reason) => {
    const read = () => parseShippedPropertiesRecord(`\n${text}`);
    expect(read).toThrow(ShippedPropertiesRecordError);
    expect(read).toThrow(reason);
  });
});

describe('shippedPropertiesLine', () => {
  it('names the properties and the type', () => {
    expect(shippedPropertiesLine({ label: 'Meeting', added: ['Tasks', 'Decisions'] })).toBe(
      'Added Tasks and Decisions to the Meeting type, which was written before DFAI shipped them.',
    );
    expect(shippedPropertiesLine({ label: 'Daily', added: ['Tags'] })).toBe(
      'Added Tags to the Daily type, which was written before DFAI shipped it.',
    );
  });
});

describe('two Macs’ records (#233)', () => {
  it('merge into every key either settled or added', () => {
    const older = { settled: { meeting: ['tasks', 'decisions'] }, added: { meeting: ['tasks'] } };
    const newer = {
      settled: { meeting: ['tasks', 'atlas_summary_of'], daily: ['date'] },
      added: { daily: ['date'] },
    };
    expect(mergeShippedPropertiesRecords(older, newer)).toEqual({
      settled: { meeting: ['tasks', 'decisions', 'atlas_summary_of'], daily: ['date'] },
      added: { meeting: ['tasks'], daily: ['date'] },
    });
  });

  it('are written as the same bytes whatever order the keys were settled in', () => {
    const one = { settled: { meeting: ['tasks', 'decisions'], daily: ['date'] }, added: {} };
    const other = {
      settled: { daily: ['date'], meeting: ['decisions', 'tasks', 'tasks'] },
      added: {},
    };
    expect(shippedPropertiesRecordText(one)).toBe(shippedPropertiesRecordText(other));
    expect(parseShippedPropertiesRecord(shippedPropertiesRecordText(other)).settled).toEqual({
      daily: ['date'],
      meeting: ['decisions', 'tasks'],
    });
  });
});

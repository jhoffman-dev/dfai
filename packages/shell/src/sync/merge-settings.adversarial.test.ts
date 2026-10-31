/**
 * Attacks on `mergeSettings` with the real markdown adapter (#233). The rule
 * the sync lives by: nothing a person wrote is ever lost. A merge by keys may
 * give up (null, and both versions are kept with a copy), but when it does
 * merge, every line either side wrote must survive, and it must never throw.
 */
import { describe, expect, it } from 'vitest';
import { mergeSettings } from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { shippedPropertiesRecordText } from '@dfai/domain';

const TYPE = '.atlas/types/meeting.md';

const merge = (versions: { base: string | null; ours: string; theirs: string }, path = TYPE) =>
  mergeSettings(remarkMarkdown, { path, ...versions });

const BASE = [
  '---',
  'name: meeting',
  'label: Meeting',
  'properties:',
  '  date:',
  '    kind: date',
  '---',
  '',
  'Meetings at Larkspur Payroll.',
  '',
].join('\n');

/** BASE with `lines` put in just before the frontmatter's closing fence. */
const withLines = (lines: string[]) =>
  BASE.replace('\n---\n\nMeetings', `\n${lines.join('\n')}\n---\n\nMeetings`);

/** The frontmatter of a merged file, read back. */
const propertiesOf = (text: string) =>
  remarkMarkdown.frontmatterProperties(text.slice(0, text.indexOf('\n---\n', 4) + 5));

describe('mergeSettings never loses what a person wrote (#233 attack)', () => {
  it('keeps a comment the other Mac’s person wrote, or gives up so a copy keeps it', () => {
    const ours = withLines(['  tasks:', '    kind: relation']);
    const note = '  # Tobias Fenn: date is the day it was held, not the invite day';
    const theirs = withLines([note]);
    const merged = merge({ base: BASE, ours, theirs });
    expect(merged === null || merged.includes(note), String(merged)).toBe(true);
  });

  it('keeps a comment this Mac’s person wrote when the other side’s file is the one kept', () => {
    const note = '# Mara Quill: keep label singular';
    const ours = BASE.replace('label: Meeting\n', `label: Meeting\n${note}\n`);
    const theirs = withLines(['  tasks:', '    kind: relation']).replace(
      'Meetings at Larkspur Payroll.',
      'Meetings at Larkspur Payroll, weekly.',
    );
    const merged = merge({ base: BASE, ours, theirs });
    expect(merged === null || merged.includes(note), String(merged)).toBe(true);
  });

  it('keeps the other side’s change to frontmatter that is a list, not a map', () => {
    const merged = merge({
      base: '---\n- standup\n---\n',
      ours: '---\n- standup\n- retro\n---\n',
      theirs: '---\n- standup\n- planning\n---\n',
    });
    expect(merged === null || merged.includes('planning'), String(merged)).toBe(true);
  });

  it('keeps the other side’s change to frontmatter that is a bare scalar', () => {
    const merged = merge({
      base: '---\nweekly\n---\n',
      ours: '---\nweekly\n---\nMara’s body.\n',
      theirs: '---\nweekly on Tuesdays\n---\n',
    });
    expect(merged === null || merged.includes('weekly on Tuesdays'), String(merged)).toBe(true);
  });

  it('does not throw when the other side added an alias to an anchor this side lacks', () => {
    const ours = withLines(['  tasks:', '    kind: relation']);
    const theirs = withLines(['title: *heading']).replace(
      'label: Meeting',
      'label: &heading Meeting',
    );
    let merged: string | null = null;
    expect(() => (merged = merge({ base: BASE, ours, theirs }))).not.toThrow();
    if (merged !== null) expect(remarkMarkdown.frontmatterProblem(merged)).toBeNull();
  });

  it('keeps entries the other side added to a map held under the key `__proto__`', () => {
    const at = (entries: string[]) =>
      ['---', 'name: meeting', '__proto__:', '  a: 1', ...entries, '---', ''].join('\n');
    const merged = merge({ base: at([]), ours: at(['  b: 2']), theirs: at(['  c: 3']) });
    expect(merged === null || merged.includes('  c: 3'), String(merged)).toBe(true);
  });

  it('keeps a note a person wrote in the shipped-properties record', () => {
    const record = (keys: string[], note = '') =>
      `---\natlas: migration\n---\n\nAtlas keeps this.\n${note}\n\`\`\`json\n${JSON.stringify({ settled: { meeting: keys } })}\n\`\`\`\n`;
    const note = 'Mara Quill: we turned atlas_summary_of off on purpose.\n';
    const merged = merge(
      { base: null, ours: record(['tasks']), theirs: record(['decisions'], note) },
      '.atlas/migrations/type-properties.md',
    );
    expect(merged === null || merged.includes(note), String(merged)).toBe(true);
  });

  it('keeps a field a person added inside the record’s JSON, by giving up to a copy', () => {
    const path = '.atlas/migrations/type-properties.md';
    const record = (keys: string[]) =>
      shippedPropertiesRecordText({ settled: { meeting: keys }, added: {} });
    const edited = record(['tasks']).replace('"added":{}', '"added":{},"why":"Mara Quill asked"');
    const merged = merge({ base: null, ours: record(['decisions']), theirs: edited }, path);
    expect(merged === null || merged.includes('Mara Quill asked'), String(merged)).toBe(true);
  });

  it('still merges an older record that says nothing of what was added', () => {
    const path = '.atlas/migrations/type-properties.md';
    const older = shippedPropertiesRecordText({
      settled: { meeting: ['tasks'] },
      added: {},
    }).replace(',"added":{}', '');
    const newer = shippedPropertiesRecordText({ settled: { meeting: ['decisions'] }, added: {} });
    expect(merge({ base: null, ours: older, theirs: newer }, path)).toContain(
      '"meeting":["decisions","tasks"]',
    );
  });

  it.each([
    ['a byte-order mark', (text: string) => `\uFEFF${text}`],
    ['trailing spaces on the opening fence', (text: string) => text.replace(/^---\n/, '---  \n')],
    [
      'trailing spaces on the closing fence',
      (text: string) => text.replace('\n---\n\n', '\n---  \n\n'),
    ],
  ])('keeps %s the side folded in has, or gives up so a copy keeps it', (_, edit) => {
    const ours = withLines(['  tasks:', '    kind: relation']);
    const theirs = edit(withLines(['  room:', '    kind: text']));
    expect(theirs).not.toBe(withLines(['  room:', '    kind: text']));
    const merged = merge({ base: edit(BASE), ours, theirs });
    const fence = (text: string) => [
      text.split('\n')[0],
      text.split('\n').find((line, at) => at > 0 && line.startsWith('---')),
    ];
    expect(merged === null || fence(merged).join() === fence(theirs).join(), String(merged)).toBe(
      true,
    );
  });
});

/** A small seeded generator (mulberry32), so every run draws the same cases. */
function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Edit {
  readonly keys: Record<string, string>;
  readonly entries: Record<string, string>;
}

const fileOf = ({ keys, entries }: Edit, body: string) =>
  [
    '---',
    'name: meeting',
    ...Object.entries(keys).map(([key, value]) => `${key}: ${value}`),
    'properties:',
    '  date:',
    '    kind: date',
    ...Object.entries(entries).flatMap(([key, kind]) => [`  ${key}:`, `    kind: ${kind}`]),
    '---',
    body,
  ].join('\n');

describe('mergeSettings property: additive edits from one base (#233 attack)', () => {
  it('for 300 seeded pairs, holds every key and entry either side added and every line of one side', () => {
    const random = seeded(233);
    const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)]!;
    const words = ['icon', 'color', 'order', 'hidden', 'tasks', 'mood', 'room', 'owner', 'cadence'];
    const kinds = ['text', 'date', 'number', 'checkbox'];
    const draw = (prefix: string): Edit => {
      const keys: Record<string, string> = {};
      const entries: Record<string, string> = {};
      const count = Math.floor(random() * 4);
      for (let at = 0; at < count; at += 1) keys[`${prefix}_${pick(words)}`] = pick(words);
      const entryCount = Math.floor(random() * 4);
      for (let at = 0; at < entryCount; at += 1) entries[`${prefix}_${pick(words)}`] = pick(kinds);
      // Some keys both sides add with the same value: not a conflict.
      if (random() < 0.3) keys['shared'] = 'same';
      return { keys, entries };
    };
    const failures: string[] = [];
    for (let round = 0; round < 300; round += 1) {
      const ours = draw('o');
      const theirs = draw('t');
      const body = '\nMeetings at Larkspur Payroll.\n';
      const oursText = fileOf(ours, body);
      const theirsText = fileOf(theirs, body);
      const merged = merge({
        base: fileOf({ keys: {}, entries: {} }, body),
        ours: oursText,
        theirs: theirsText,
      });
      if (merged === null) {
        failures.push(`round ${round}: null for ${JSON.stringify({ ours, theirs })}`);
        continue;
      }
      const read = propertiesOf(merged);
      const properties = read['properties'] as Record<string, { kind: string }>;
      for (const edit of [ours, theirs]) {
        for (const [key, value] of Object.entries(edit.keys)) {
          if (read[key] !== value) failures.push(`round ${round}: lost key ${key}`);
        }
        for (const [key, kind] of Object.entries(edit.entries)) {
          if (properties[key]?.kind !== kind) failures.push(`round ${round}: lost entry ${key}`);
        }
      }
      const kept = [oursText, theirsText].some((side) => {
        let from = 0;
        return side.split('\n').every((line) => {
          const found = merged.split('\n').indexOf(line, from);
          from = found + 1;
          return found !== -1;
        });
      });
      if (!kept) failures.push(`round ${round}: neither side’s lines kept in order`);
    }
    expect(failures.slice(0, 5)).toEqual([]);
  });
});

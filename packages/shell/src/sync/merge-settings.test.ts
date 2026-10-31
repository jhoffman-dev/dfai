/**
 * `mergeSettings` with the real markdown adapter (#233): what the sync writes
 * for a settings file both Macs changed — every line of the side it keeps
 * byte for byte (ADR-0003), and the other side's additions as new lines.
 */
import { describe, expect, it } from 'vitest';
import { mergeSettings } from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { shippedPropertiesRecordText } from '@dfai/domain';

const TYPE = '.atlas/types/meeting.md';

const typeFile = (properties: string[], { extra = '', body = '\nMeetings.\n' } = {}) =>
  [
    '---',
    'name: meeting',
    '# kept as written',
    'label: Meeting',
    ...(extra === '' ? [] : [extra]),
    'properties:',
    ...properties,
    '---',
    body,
  ].join('\n');

const ATTENDEES = ['  attendees:', '    kind: relation', '    target: person'];
const TASKS = ['  tasks:', '    kind: relation', '    target: task', '    many: true'];
const SUMMARY = ['  atlas_summary_of: { kind: text, label: Summary of }'];

const merge = (versions: { base: string | null; ours: string; theirs: string }, path = TYPE) =>
  mergeSettings(remarkMarkdown, { path, ...versions });

const keysOf = (text: string) =>
  Object.keys(
    remarkMarkdown.frontmatterProperties(text.slice(0, text.indexOf('\n---\n') + 5))[
      'properties'
    ] as Record<string, unknown>,
  );

describe('mergeSettings (#233)', () => {
  it('keeps this Mac’s file byte for byte and puts the other’s new entries after its own', () => {
    const base = typeFile(ATTENDEES);
    const ours = typeFile([...ATTENDEES, ...TASKS]);
    const theirs = typeFile([...ATTENDEES, ...SUMMARY]);
    const merged = merge({ base, ours, theirs });
    expect(merged).not.toBeNull();
    expect(merged!.startsWith(ours.slice(0, ours.indexOf('\n---\n')))).toBe(true);
    expect(merged!.endsWith('---\n\nMeetings.\n')).toBe(true);
    expect(keysOf(merged!)).toEqual(['attendees', 'tasks', 'atlas_summary_of']);
  });

  it('is this Mac’s file exactly when it already holds everything the other added', () => {
    const base = typeFile(ATTENDEES);
    const ours = typeFile([...ATTENDEES, ...TASKS, ...SUMMARY]);
    const theirs = typeFile([...ATTENDEES, ...TASKS]);
    expect(merge({ base, ours, theirs })).toBe(ours);
  });

  it('writes this Mac’s additions into the other’s file when only that way round is additive', () => {
    const base = typeFile(ATTENDEES);
    const ours = typeFile([...ATTENDEES, ...TASKS]);
    const theirs = typeFile(ATTENDEES, { body: '\nMeetings, rewritten.\n' });
    const merged = merge({ base, ours, theirs });
    expect(merged?.endsWith('\nMeetings, rewritten.\n')).toBe(true);
    expect(keysOf(merged!)).toEqual(['attendees', 'tasks']);
  });

  it('copies a top-level key the other side added as it wrote it', () => {
    const base = typeFile(ATTENDEES);
    const theirs = typeFile(ATTENDEES, { extra: 'icon:   "calendar" # theirs' });
    const merged = merge({ base, ours: base, theirs });
    expect(merged).toContain('icon:   "calendar" # theirs\n');
  });

  it.each([
    ['a comment', (text: string) => text.replace('label: Meeting\n', 'label: Meeting # Mara’s\n')],
    [
      'a reorder',
      (text: string) =>
        text.replace(
          'name: meeting\n# kept as written\nlabel: Meeting\n',
          'label: Meeting\nname: meeting\n# kept as written\n',
        ),
    ],
    ['a restyle', (text: string) => text.replace('label: Meeting', 'label: "Meeting"')],
  ])(
    'keeps %s on either side, whole, with the other side’s additions — or a copy when both edited',
    (_, edit) => {
      const base = typeFile(ATTENDEES);
      const added = typeFile([...ATTENDEES, ...TASKS]);
      const edited = edit(base);
      expect(edited).not.toBe(base);
      for (const [ours, theirs] of [
        [edited, added],
        [added, edited],
      ] as const) {
        const merged = merge({ base, ours, theirs });
        expect(merged).toBe(edit(added));
      }
      expect(
        merge({
          base,
          ours: edit(added),
          theirs: typeFile([...ATTENDEES, ...SUMMARY]).replace('name: meeting', 'name: meetings'),
        }),
      ).toBeNull();
    },
  );

  it('is null for a real conflict: both Macs gave a key different values', () => {
    const base = typeFile(ATTENDEES);
    const ours = typeFile(ATTENDEES, { extra: 'icon: calendar' });
    const theirs = typeFile(ATTENDEES, { extra: 'icon: phone' });
    expect(merge({ base, ours, theirs })).toBeNull();
  });

  it('is null when the new entries cannot go in as lines: an inline map', () => {
    const inline = (keys: string) =>
      `---\nname: meeting\nproperties: { ${keys} }\n---\n\nMeetings.\n`;
    expect(
      merge({
        base: inline('date: { kind: date }'),
        ours: inline('date: { kind: date }, tasks: { kind: text }'),
        theirs: inline('date: { kind: date }, mood: { kind: text }'),
      }),
    ).toBeNull();
  });

  // #394: key texts keep the block's indent, so they still join back into the
  // block exactly and an indented file merges by its keys like any other.
  describe('a file whose keys are indented', () => {
    const indented = (by: number, text: string) =>
      text.replace(/^(?!---)(?=.)/gm, (_, at: number) =>
        at < text.indexOf('\n---\n', 4) ? ' '.repeat(by) : '',
      );

    it('merges by its keys: a key the other side added comes in at the block’s indent', () => {
      const base = indented(2, typeFile(ATTENDEES));
      const theirs = indented(2, typeFile(ATTENDEES, { extra: 'icon: calendar' }));
      const merged = merge({ base, ours: base, theirs });
      expect(merged).toBe(base.replace('\n---\n', '\n  icon: calendar\n---\n'));
      expect(keysOf(merged!)).toEqual(['attendees']);
    });

    it('is null when the two sides indent their keys differently: lines cannot be mixed', () => {
      const base = indented(2, typeFile(ATTENDEES));
      const ours = indented(2, typeFile([...ATTENDEES, ...TASKS]));
      const theirs = indented(4, typeFile(ATTENDEES, { extra: 'icon: calendar' }));
      expect(merge({ base, ours, theirs })).toBeNull();
    });
  });

  it('is null for a file whose frontmatter cannot be read, or that has none', () => {
    const base = typeFile(ATTENDEES);
    expect(merge({ base, ours: '---\nname: [\n---\n', theirs: base })).toBeNull();
    expect(merge({ base, ours: 'No frontmatter.\n', theirs: base })).toBeNull();
  });

  it('is null for a file outside `.atlas`: a note is the person’s, kept whole with a copy', () => {
    const base = typeFile(ATTENDEES);
    const ours = typeFile([...ATTENDEES, ...TASKS]);
    expect(merge({ base, ours, theirs: base }, 'Notes/meeting.md')).toBeNull();
  });

  it('merges the record of shipped properties as the union, an older build’s unsorted one too', () => {
    const path = '.atlas/migrations/type-properties.md';
    const record = (keys: string[]) =>
      shippedPropertiesRecordText({ settled: { meeting: keys }, added: {} });
    const unsorted = record(['tasks', 'decisions']).replace(
      '"meeting":["decisions","tasks"]',
      '"meeting":["tasks","decisions"]',
    );
    const merged = merge(
      { base: null, ours: unsorted, theirs: record(['atlas_summary_of']) },
      path,
    );
    expect(merged).toContain('"meeting":["atlas_summary_of","decisions","tasks"]');
  });

  it('refuses a record a person wrote in, or one a key was taken off by hand', () => {
    const path = '.atlas/migrations/type-properties.md';
    const record = (keys: string[]) =>
      shippedPropertiesRecordText({ settled: { meeting: keys }, added: {} });
    expect(merge({ base: null, ours: 'mine\n', theirs: record([]) }, path)).toBeNull();
    const noted = record(['tasks']).replace('```json', 'Mara Quill: keep it off.\n\n```json');
    expect(merge({ base: null, ours: noted, theirs: record(['decisions']) }, path)).toBeNull();
    expect(
      merge(
        { base: record(['tasks']), ours: record([]), theirs: record(['tasks', 'decisions']) },
        path,
      ),
    ).toBeNull();
  });
});

describe('mergeSettings on a record broken past the block that parses (#235)', () => {
  it('gives up with null rather than throwing, so the sync goes on', () => {
    const good = shippedPropertiesRecordText({ settled: {}, added: {} });
    const json = JSON.stringify({ settled: {}, added: {} });
    expect(good).toContain(json);
    // Block 1 parses, over two lines; block 2, on one line, is cut short.
    const broken = good.replace(json, '{"settled":\n{}}\n```\n\n```json\n{"a');
    const path = '.atlas/migrations/type-properties.md';
    expect(() => merge({ base: null, ours: broken, theirs: broken }, path)).not.toThrow();
    expect(merge({ base: null, ours: broken, theirs: broken }, path)).toBeNull();
  });
});

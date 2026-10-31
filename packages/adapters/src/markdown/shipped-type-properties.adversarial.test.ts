/**
 * Adversarial: #162's migration of shipped properties into built-in type
 * files, through the real YAML reader and writer, over a vault in memory
 * whose host refuses a write to a file that moved on since it was read.
 */
import { describe, expect, it } from 'vitest';
import {
  createVaultPath,
  parentVaultPath,
  parseShippedPropertiesRecord,
  PROPERTIES_NOT_A_MAP,
  PROPERTIES_NOT_ADDABLE_AS_LINES,
  SHIPPED_PROPERTIES_RECORD_PATH,
  shippedPropertiesRecordText,
  splitFrontmatter,
  type VaultEntry,
} from '@dfai/domain';
import { ensureBuiltInTypes, loadObjectTypes, type VaultFsPort } from '@dfai/application';
import { remarkMarkdown } from './markdown-port.ts';

function memoryHost(initial: Record<string, string>) {
  const files = new Map<string, { text: string; modified: number }>(
    Object.entries(initial).map(([path, text]) => [path, { text, modified: 1 }]),
  );
  let clock = 1;
  const folders = new Set<string>();
  const hasFolder = (folder: string) =>
    folder === '' ||
    folders.has(folder) ||
    [...files.keys()].some((p) => p.startsWith(`${folder}/`));
  const failing = new Set<string>();
  const fs: VaultFsPort = {
    listDirectory: async (folder) => {
      if (failing.has(folder)) throw new Error('Operation timed out');
      if (!hasFolder(folder)) throw new Error('no such folder');
      const names = new Map<string, VaultEntry>();
      const prefix = folder === '' ? '' : `${folder}/`;
      for (const path of [...files.keys(), ...folders]) {
        if (!path.startsWith(prefix) || path === folder) continue;
        const [first = '', ...more] = path.slice(prefix.length).split('/');
        const at = createVaultPath(`${prefix}${first}`);
        names.set(
          first,
          more.length > 0 || folders.has(at)
            ? ({ kind: 'directory', name: first, path: at } as VaultEntry)
            : ({ kind: 'file', name: first, path: at, modified: 0, size: 0 } as VaultEntry),
        );
      }
      return [...names.values()];
    },
    listFiles: async () => [],
    listNotes: async () => [],
    readNotes: async (paths) =>
      paths.flatMap((path) => {
        const file = files.get(path);
        return file === undefined ? [] : [{ path, ...file, size: file.text.length }];
      }),
    readTextFile: async (path) => {
      const file = files.get(path);
      if (file === undefined) throw new Error(`no such file: ${path}`);
      return file;
    },
    readBinaryFile: async () => new ArrayBuffer(0),
    createNote: async ({ path, contents }) => {
      if (files.has(path)) throw new Error('something with that name is already there');
      if (!hasFolder(parentVaultPath(path))) throw new Error('that folder does not exist');
      const modified = ++clock;
      files.set(path, { text: contents, modified });
      return modified;
    },
    createFolder: async ({ path }) => {
      if (hasFolder(path)) throw new Error('something with that name is already there');
      folders.add(path);
    },
    moveEntry: async () => {},
    trashEntry: async () => {},
    writeTextFile: async ({ path, contents, expectedModified }) => {
      const file = files.get(path);
      if (file === undefined) throw new Error(`no such file: ${path}`);
      if (expectedModified !== null && expectedModified !== file.modified) {
        throw new Error(`${path} changed since it was read`);
      }
      files.set(path, { text: contents, modified: ++clock });
      return clock;
    },
    writeBinaryFile: async () => 0,
  };
  const text = (path: string) => files.get(path)?.text ?? '';
  const set = (path: string, contents: string) =>
    files.set(path, { text: contents, modified: ++clock });
  return { fs, markdown: remarkMarkdown, text, set, files, failing };
}

/** The type file's frontmatter as YAML reads it. */
const frontmatterOf = (text: string) =>
  remarkMarkdown.frontmatterProperties(splitFrontmatter(text).frontmatter);

describe('#162 migration, on a type file whose `properties` is not a map', () => {
  it('never overwrites a hand-written list of properties with DFAI’s map', async () => {
    const meeting = [
      '---',
      'name: meeting',
      'label: Meeting',
      'properties:',
      '  - title',
      '  - attendees',
      '---',
      '',
      '# Meeting',
      '',
    ].join('\n');
    const v = memoryHost({ '.atlas/types/meeting.md': meeting });

    await ensureBuiltInTypes(v);

    // What the person wrote under `properties` is theirs; DFAI could not read
    // it, so it must not be replaced. Additive only (shippedPropertiesPlan's contract).
    expect(v.text('.atlas/types/meeting.md')).toContain('  - title\n  - attendees\n');
  });

  it('never overwrites a scalar `properties` value with DFAI’s map', async () => {
    const daily = [
      '---',
      'name: daily',
      'properties: see the Daily note in Resources',
      '---',
      '',
    ].join('\n');
    const v = memoryHost({ '.atlas/types/daily.md': daily });

    await ensureBuiltInTypes(v);

    expect(v.text('.atlas/types/daily.md')).toContain('see the Daily note in Resources');
  });
});

describe('#162 migration, on a type file it cannot add a line to', () => {
  it('leaves a list of properties alone, settles nothing, and says why', async () => {
    const listed = ['---', 'name: meeting', 'properties:', '  - title', '---', ''].join('\n');
    const v = memoryHost({ '.atlas/types/meeting.md': listed });

    const { properties } = await ensureBuiltInTypes(v);

    expect(v.text('.atlas/types/meeting.md')).toBe(listed);
    expect(v.files.has(SHIPPED_PROPERTIES_RECORD_PATH)).toBe(false);
    expect(properties.skipped).toEqual([
      { path: '.atlas/types/meeting.md', label: 'Meeting', reason: PROPERTIES_NOT_A_MAP },
    ]);
  });

  it('leaves an inline map alone, settles nothing, and says why', async () => {
    const inline = ['---', 'name: daily', 'properties: {date: date}', '---', ''].join('\n');
    const v = memoryHost({ '.atlas/types/daily.md': inline });

    const { properties } = await ensureBuiltInTypes(v);

    expect(v.text('.atlas/types/daily.md')).toBe(inline);
    expect(v.files.has(SHIPPED_PROPERTIES_RECORD_PATH)).toBe(false);
    expect(properties.skipped).toEqual([
      { path: '.atlas/types/daily.md', label: 'daily', reason: PROPERTIES_NOT_ADDABLE_AS_LINES },
    ]);
  });

  it('adds to a file with 4-space indents, comments and folded text as lines only', async () => {
    const indented = [
      '---',
      'name: daily',
      'properties: # mine',
      '    date:',
      '        kind: date # the day',
      '        label: >-',
      '            The',
      '            day',
      '---',
      '',
    ].join('\n');
    const v = memoryHost({ '.atlas/types/daily.md': indented });

    const { properties } = await ensureBuiltInTypes(v);

    const head = indented.slice(0, indented.indexOf('---\n', 4));
    const written = v.text('.atlas/types/daily.md');
    expect(properties.gained.map((gained) => gained.path)).toEqual(['.atlas/types/daily.md']);
    expect(written.startsWith(head)).toBe(true);
    expect(written.slice(head.length)).toMatch(/^ {4}\w+:/);
    expect(written.endsWith('---\n')).toBe(true);
  });
});

describe('#162 migration, on two type files that both name the Meeting type', () => {
  // accept-proposal.ts:249, claude-step.ts:513 and linked-sections.ts:82 take
  // the FIRST type whose folded name is `meeting`, and which file that is the
  // migration cannot know: it changes neither, settles nothing, and asks for
  // them to be merged — and the Inbox offers no change to either.
  it('changes neither file, settles nothing, and asks for the two to be merged', async () => {
    // Mara Quill's vault, synced between two Macs: her Meeting type and the
    // sync's conflict copy of it, both `name: meeting`.
    const meeting = (label: string) =>
      ['---', 'name: meeting', `label: ${label}`, 'properties:', '  title: text', '---', ''].join(
        '\n',
      );
    const v = memoryHost({
      '.atlas/types/meeting.md': meeting('Meeting'),
      '.atlas/types/meeting 2.md': meeting('Meeting (conflict copy)'),
    });

    const ensured = await ensureBuiltInTypes(v);

    expect(v.text('.atlas/types/meeting.md')).toBe(meeting('Meeting'));
    expect(v.text('.atlas/types/meeting 2.md')).toBe(meeting('Meeting (conflict copy)'));
    expect(v.files.has(SHIPPED_PROPERTIES_RECORD_PATH)).toBe(false);
    expect(ensured.properties.skipped).toEqual([
      expect.objectContaining({
        label: 'Meeting',
        reason: expect.stringContaining('two files say they are the Meeting type: merge them'),
      }),
    ]);
    expect(ensured.offer.extensions).toEqual([]);
    const types = await loadObjectTypes(v);
    for (const type of types) {
      expect(type.properties.map((property) => property.key)).not.toContain('tasks');
    }
  });
});

describe('#162 migration, through the real YAML writer', () => {
  it('leaves the lines of the properties the file already had exactly as written', async () => {
    const indented = [
      '---',
      'name: meeting',
      'properties: # Mara’s own',
      '    title:',
      '        kind: text',
      '        label: >-',
      '            What the',
      '            call was',
      '    when: date',
      '---',
      '',
    ].join('\n');
    const v = memoryHost({ '.atlas/types/meeting.md': indented });

    await ensureBuiltInTypes(v);

    // "only the properties added are written, after the file's own, and its
    // body and every key it had stay as they were" (add-shipped-properties.ts).
    const kept = indented.slice(0, indented.indexOf('---\n', 4));
    expect(v.text('.atlas/types/meeting.md').startsWith(kept)).toBe(true);
  });

  it('adds no key of its own making beside a key the file wrote with spaces around it', async () => {
    const spaced = [
      '---',
      'name: meeting',
      'properties:',
      '  " title": text',
      '  when: date',
      '---',
      '',
    ].join('\n');
    const v = memoryHost({ '.atlas/types/meeting.md': spaced });

    await ensureBuiltInTypes(v);

    const keys = Object.keys(
      (frontmatterOf(v.text('.atlas/types/meeting.md'))['properties'] ?? {}) as object,
    );
    // Only shipped keys may appear that were not there; `title: null` is not one.
    expect(keys).not.toContain('title');
  });
});

describe('#162 migration, when its record is there but cannot be listed', () => {
  it('does not put back a key the person took off because a listing failed', async () => {
    const v = memoryHost({ '.atlas/types/meeting.md': '---\nname: meeting\n---\n' });
    await ensureBuiltInTypes(v);
    // Mara takes `tasks` off her Meeting type: it is settled, so it stays off.
    const without = '---\nname: meeting\nproperties:\n  title: text\n---\n';
    v.set('.atlas/types/meeting.md', without);
    // The next open, the host fails to list the migrations folder (not "no such folder").
    v.failing.add('.atlas/migrations');

    await ensureBuiltInTypes(v);

    expect(v.text('.atlas/types/meeting.md')).toBe(without);
  });
});

describe('#162 migration, when the vault is opened twice at once', () => {
  // React StrictMode (packages/shell/src/mount-shell.tsx) runs useBuiltInTypes' effect
  // twice in development; the first run is only marked cancelled, not stopped.
  it('reports no failure for a type the other open just gave the properties', async () => {
    const meeting = ['---', 'name: meeting', 'properties:', '  title: text', '---', ''].join('\n');
    const v = memoryHost({ '.atlas/types/meeting.md': meeting });

    const [first, second] = await Promise.all([ensureBuiltInTypes(v), ensureBuiltInTypes(v)]);

    expect([...first.properties.failed, ...second.properties.failed]).toEqual([]);
  });
});

describe('#162 record, as another tool may save it', () => {
  it('reads back a record whose line endings were turned to CRLF', () => {
    const written = shippedPropertiesRecordText({
      settled: { meeting: ['tasks', 'decisions'] },
      added: {},
    });

    expect(() => parseShippedPropertiesRecord(written.replace(/\n/g, '\r\n'))).not.toThrow();
  });
});

describe('#162 migration, on a type file whose frontmatter holds a self-referring anchor', () => {
  // addToFrontmatterMap's read-back check JSON.stringifies the parsed block;
  // a YAML cycle makes that throw, so the type is reported as failed — with
  // the JS engine's message — on every vault open, instead of left alone and
  // said why (or added to).
  it('does not fail the type with a JSON error', async () => {
    const meeting = [
      '---',
      'name: meeting',
      'label: Meeting',
      'extra: &e',
      '  me: *e',
      'properties:',
      '  title: text',
      '---',
      '',
      '# Meeting',
      '',
    ].join('\n');
    const v = memoryHost({ '.atlas/types/meeting.md': meeting });

    const { properties } = await ensureBuiltInTypes(v);

    expect(properties.failed).toEqual([]);
  });
});

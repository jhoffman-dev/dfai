/**
 * The write behind every property edit that does not go through the editor.
 *
 * A table cell, a board drag and a timeline drag all end up here, and all of
 * them are writing to a file the person may have open somewhere else — so what
 * is asserted is that the note is read once, written once, and comes back with
 * everything nobody asked to change still in it.
 */

import { describe, expect, it } from 'vitest';
import { NoteChangedError } from '../notes/note-changed-error.ts';
import { fakeMarkdown, fakeVaultFs } from '../testing/fake-ports.ts';
import {
  setNoteProperties,
  setNoteProperty,
  UnclosedFrontmatterError,
  writeFrontmatterChanges,
} from './set-property.ts';

const NOTE = [
  '---',
  'status: doing',
  'due: 2026-01-05',
  '---',
  '',
  '# Ship it',
  '',
  'Body.',
  '',
].join('\n');

function vault(text = NOTE) {
  const reads: string[] = [];
  const writes: { path: string; contents: string; expectedModified: number | null }[] = [];
  const fs = fakeVaultFs({
    readTextFile: async (path) => {
      reads.push(path);
      return { text, modified: 17 };
    },
    writeTextFile: async ({ path, contents, expectedModified }) => {
      writes.push({ path, contents, expectedModified });
      return 18;
    },
  });
  return { fs, reads, writes };
}

const written = (contents: string): Record<string, string> =>
  Object.fromEntries(
    contents
      .split('\n')
      .map((line) => /^(\w+):\s*(.*)$/.exec(line))
      .filter((found) => found !== null)
      .map((found) => [found[1] ?? '', found[2] ?? '']),
  );

const completion = { statusKey: 'status', doneValue: 'done', resetStatus: 'todo' };

describe('setNoteProperties', () => {
  it('writes the changed keys and leaves the others alone', async () => {
    const { fs, writes } = vault();
    await setNoteProperties({
      today: '2026-10-08',
      fs,
      markdown: fakeMarkdown(),
      path: 'Tasks/ship.md',
      values: { scheduled: '2026-02-01', due: '2026-02-08' },
    });

    expect(written(writes[0]?.contents ?? '')).toEqual({
      status: 'doing',
      due: '2026-02-08',
      scheduled: '2026-02-01',
    });
  });

  it('keeps the body exactly as it was', async () => {
    const { fs, writes } = vault();
    await setNoteProperties({
      today: '2026-10-08',
      fs,
      markdown: fakeMarkdown(),
      path: 'Tasks/ship.md',
      values: { due: '2026-02-08' },
    });

    expect(writes[0]?.contents).toContain('\n# Ship it\n\nBody.\n');
  });

  it('writes against the version it read, so a change underneath is caught', async () => {
    const { fs, writes } = vault();
    await setNoteProperties({
      today: '2026-10-08',
      fs,
      markdown: fakeMarkdown(),
      path: 'Tasks/ship.md',
      values: { due: '2026-02-08' },
    });

    expect(writes[0]).toMatchObject({ path: 'Tasks/ship.md', expectedModified: 17 });
  });

  it('refuses, writing nothing, when the note moved on from the time the caller read', async () => {
    const { fs, writes } = vault();
    const write = setNoteProperties({
      today: '2026-10-08',
      fs,
      markdown: fakeMarkdown(),
      path: 'Tasks/ship.md',
      values: { due: '2026-02-08' },
      ifModified: 16,
    });

    await expect(write).rejects.toBeInstanceOf(NoteChangedError);
    expect(writes).toEqual([]);
  });

  it('writes when the note is still at the time the caller read', async () => {
    const { fs, writes } = vault();
    await setNoteProperties({
      today: '2026-10-08',
      fs,
      markdown: fakeMarkdown(),
      path: 'Tasks/ship.md',
      values: { due: '2026-02-08' },
      ifModified: 17,
    });

    expect(writes).toHaveLength(1);
  });

  it('reads the note once and writes it once', async () => {
    const { fs, reads, writes } = vault();
    await setNoteProperties({
      today: '2026-10-08',
      fs,
      markdown: fakeMarkdown(),
      path: 'Tasks/ship.md',
      values: { due: '2026-02-08' },
    });

    expect([reads.length, writes.length]).toEqual([1, 1]);
  });

  it('works the changes out from the properties the note has, when asked to', async () => {
    const { fs, writes } = vault();
    await setNoteProperties({
      today: '2026-10-08',
      fs,
      markdown: fakeMarkdown(),
      path: 'Tasks/ship.md',
      values: (properties) => ({ previous: properties['due'] }),
    });

    expect(written(writes[0]?.contents ?? '')['previous']).toBe('2026-01-05');
  });

  it('writes nothing when given nothing to change', async () => {
    const { fs, writes } = vault('---\nstatus: doing\n---\n\nBody.\n');
    await setNoteProperties({
      today: '2026-10-08',
      fs,
      markdown: fakeMarkdown(),
      path: 'Tasks/ship.md',
      values: {},
    });

    expect(writes).toHaveLength(0);
  });

  it('writes nothing when its changes leave every byte as it was (#225, PR #612)', async () => {
    const { fs, writes } = vault('---\nstatus: doing\n---\n\nBody.\n');
    await setNoteProperties({
      today: '2026-10-08',
      fs,
      markdown: fakeMarkdown(),
      path: 'Tasks/ship.md',
      // A value set to what it is, and a key taken away that is not there.
      values: { status: 'doing', due: null },
    });

    expect(writes).toHaveLength(0);
  });
});

describe('writeFrontmatterChanges, on a file whose block never closes (#683)', () => {
  const UNCLOSED = '---\nname: film\nlabel: Film\n\n# Film\n';

  it('writes nothing over it, and says why', async () => {
    const { fs, writes } = vault(UNCLOSED);
    await expect(
      writeFrontmatterChanges({
        fs,
        markdown: fakeMarkdown(),
        path: '.atlas/types/film.md',
        values: { label: 'Films' },
      }),
    ).rejects.toThrowError(new UnclosedFrontmatterError('.atlas/types/film.md'));
    expect(writes).toEqual([]);
    expect(new UnclosedFrontmatterError('.atlas/types/film.md').message).toBe(
      '.atlas/types/film.md has a frontmatter block with no closing ---, so nothing was written to it: add the --- line that ends the block, then try again',
    );
  });

  it('leaves a note as it was: a note whose block never closes is all body, as Obsidian reads it', async () => {
    const { fs, writes } = vault(UNCLOSED);
    await setNoteProperties({
      today: '2026-10-08',
      fs,
      markdown: fakeMarkdown(),
      path: 'Film.md',
      values: { status: 'done' },
    });
    // Its text is kept whole under a block of its own; nothing in it is lost.
    expect(writes[0]?.contents.endsWith(UNCLOSED)).toBe(true);
  });

  it('still gives a file with no block one of its own', async () => {
    const { fs, writes } = vault('# Film\n');
    await writeFrontmatterChanges({
      fs,
      markdown: fakeMarkdown(),
      path: '.atlas/settings.md',
      values: { label: 'Films' },
    });
    expect(writes).toHaveLength(1);
  });
});

describe('setNoteProperty', () => {
  it('changes the one property it was given', async () => {
    const { fs, writes } = vault();
    await setNoteProperty({
      today: '2026-10-08',
      fs,
      markdown: fakeMarkdown(),
      path: 'Tasks/ship.md',
      key: 'status',
      value: 'done',
    });

    expect(written(writes[0]?.contents ?? '')).toEqual({ status: 'done', due: '2026-01-05' });
  });

  it('reads the note once, even when a completion rule is in play', async () => {
    const { fs, reads } = vault(
      '---\nstatus: doing\ndue: 2026-01-05\nrecurrence: every week\n---\n\nBody.\n',
    );
    await setNoteProperty({
      today: '2026-10-08',
      fs,
      markdown: fakeMarkdown(),
      path: 'Tasks/ship.md',
      key: 'status',
      value: 'done',
      completion,
    });

    expect(reads).toHaveLength(1);
  });

  it('rolls a repeating task forward instead of finishing it', async () => {
    const { fs, writes } = vault(
      '---\nstatus: doing\ndue: 2026-01-05\nrecurrence: every week\n---\n\nBody.\n',
    );
    await setNoteProperty({
      today: '2026-10-08',
      fs,
      markdown: fakeMarkdown(),
      path: 'Tasks/ship.md',
      key: 'status',
      value: 'done',
      completion,
    });

    expect(written(writes[0]?.contents ?? '')).toMatchObject({
      status: 'todo',
      due: '2026-01-12',
      lastCompleted: '2026-01-05',
    });
  });

  it('finishes a task that does not repeat', async () => {
    const { fs, writes } = vault();
    await setNoteProperty({
      today: '2026-10-08',
      fs,
      markdown: fakeMarkdown(),
      path: 'Tasks/ship.md',
      key: 'status',
      value: 'done',
      completion,
    });

    expect(written(writes[0]?.contents ?? '')['status']).toBe('done');
  });

  it('leaves a repeating task alone when the change is not finishing it', async () => {
    const { fs, writes } = vault(
      '---\nstatus: doing\ndue: 2026-01-05\nrecurrence: every week\n---\n\nBody.\n',
    );
    await setNoteProperty({
      today: '2026-10-08',
      fs,
      markdown: fakeMarkdown(),
      path: 'Tasks/ship.md',
      key: 'due',
      value: '2026-03-01',
      completion,
    });

    expect(written(writes[0]?.contents ?? '')).toMatchObject({
      status: 'doing',
      due: '2026-03-01',
    });
  });
});

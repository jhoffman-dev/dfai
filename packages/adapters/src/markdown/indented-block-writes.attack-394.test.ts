/**
 * Adversarial pass on #394 (#377), end to end: the application's writes run
 * against the real markdown adapter and an in-memory vault, on notes whose
 * frontmatter keys are indented. Each write must leave the block readable,
 * put what it changed at the block's indent, and keep every untouched line.
 *
 * The writes that give a key back as the text it was read as — the Today
 * page's undo, unarchiving — hand `updateFrontmatter` the indented text
 * `frontmatterKeyTexts` returns; those are the failing tests here.
 */
import { describe, expect, it } from 'vitest';
import {
  archiveNotes,
  archiveTaskChange,
  changeUndoably,
  clarifyInboxItem,
  fakeIndexPort,
  fakeVaultFs,
  FrontmatterRefusedError,
  memoryVault,
  openNote,
  previewParaMigration,
  rejectProposalNote,
  renameTagInNote,
  runParaMigration,
  saveNote,
  setNoteProperties,
  setNoteProperty,
  unarchiveNotes,
  writeFrontmatterChanges,
  type ArchivePorts,
  type PropertyChanges,
} from '@dfai/application';
import { createVaultPath, splitFrontmatter, TASK_KEYS } from '@dfai/domain';
import { addToFrontmatterMap } from './frontmatter-add.ts';
import { frontmatterProblem } from './frontmatter.ts';
import { remarkMarkdown } from './markdown-port.ts';

const TODAY = '2026-10-19';
const NOTE = 'Tasks/Water the ferns.md';
const markdown = remarkMarkdown;
const BODY = '\nKeep the soil damp.\n';

/** A note whose frontmatter keys all sit at `indent` spaces. */
const indentedNote = (indent: number, ...lines: string[]) =>
  `---\n${lines.map((line) => `${' '.repeat(indent)}${line}`).join('\n')}\n---\n${BODY}`;

const propertiesOf = (text: string) =>
  markdown.frontmatterProperties(splitFrontmatter(text).frontmatter ?? '');
const problemOf = (text: string) => frontmatterProblem(splitFrontmatter(text).frontmatter);

const closedEditors: ArchivePorts['editors'] = {
  state: () => 'closed',
  flush: async () => {},
  follow: () => {},
  abandon: () => {},
  reload: () => {},
};

/** A vault of notes, every one stamped anew by each write as a file is. */
function vault(files: Record<string, string>) {
  const memory = memoryVault(files);
  let stamp = 1;
  const fs = fakeVaultFs({
    ...memory.fs,
    readTextFile: async (path) => ({ ...(await memory.fs.readTextFile(path)), modified: stamp }),
    readNotes: async (paths) =>
      paths.flatMap((path) => {
        const text = memory.files.get(path);
        return text === undefined ? [] : [{ path, text, modified: stamp, size: text.length }];
      }),
    writeTextFile: async (write) => {
      if (write.expectedModified !== undefined && write.expectedModified !== stamp) {
        throw new Error('the file changed underneath');
      }
      stamp += 1;
      return memory.fs.writeTextFile(write);
    },
  });
  const ports: ArchivePorts = { fs, markdown, index: fakeIndexPort(), editors: closedEditors };
  const notePaths = () => [...memory.files.keys()].map((path) => createVaultPath(path));
  return {
    fs,
    ports,
    notePaths,
    files: memory.files,
    text: (path = NOTE) => memory.files.get(path),
  };
}

describe('#394 the Today page’s tick and undo on an indented task', () => {
  /** Makes a change as the Today page does, and answers with its undo. */
  async function changeThenUndo(text: string, values: PropertyChanges) {
    const v = vault({ [NOTE]: text });
    const write = (changes: PropertyChanges, ifModified?: number) =>
      setNoteProperties({
        fs: v.fs,
        markdown,
        path: NOTE,
        values: changes,
        today: TODAY,
        ...(ifModified !== undefined && { ifModified }),
      });
    const made = await changeUndoably({
      fs: v.fs,
      markdown,
      path: NOTE,
      write: (readAt) => write(values, readAt),
    });
    if (made.undo === null) throw new Error('no undo was offered');
    const changed = v.text() ?? '';
    await write(made.undo);
    return { changed, undone: v.text() ?? '' };
  }

  it.each([1, 2, 4])(
    'a tick then its undo gives the task back byte for byte, at an indent of %i',
    async (n) => {
      const task = indentedNote(n, 'type: task', 'status: next-action', 'due: 2026-10-20');
      const { changed, undone } = await changeThenUndo(task, archiveTaskChange());
      expect(propertiesOf(changed)).toMatchObject({ status: 'archive', completed: TODAY });
      expect(problemOf(changed)).toBeNull();
      expect(undone).toBe(task);
    },
  );

  it('the undo of a move keeps the task’s status rather than removing it', async () => {
    const task = indentedNote(2, 'type: task', 'status: next-action', 'due: 2026-10-20');
    const { undone } = await changeThenUndo(task, { [TASK_KEYS.status]: 'someday' });
    expect(propertiesOf(undone)).toMatchObject({ status: 'next-action' });
  });

  it('control: on an unindented task the same tick and undo is byte for byte', async () => {
    const task = indentedNote(0, 'type: task', 'status: next-action', 'due: 2026-10-20');
    const { undone } = await changeThenUndo(task, archiveTaskChange());
    expect(undone).toBe(task);
  });
});

describe('#394 archive and unarchive on an indented note', () => {
  async function roundTrip(path: string, text: string) {
    const v = vault({ [path]: text });
    const archived = await archiveNotes({
      ports: v.ports,
      paths: [createVaultPath(path)],
      notePaths: v.notePaths(),
      today: TODAY,
    });
    expect(archived.failed).toEqual([]);
    const moved = archived.moves[0]!.move.to;
    const stamped = v.files.get(moved) ?? '';
    const restored = await unarchiveNotes({
      ports: v.ports,
      paths: [moved],
      notePaths: v.notePaths(),
    });
    expect(restored.failed).toEqual([]);
    return { stamped, back: v.files.get(path) };
  }

  it.each([1, 2, 4])(
    'guard: a note with no stamp keys of its own comes back byte for byte (indent %i)',
    async (n) => {
      const text = indentedNote(n, 'title: Plan', 'tags:', '  - home', 'status: open');
      const { stamped, back } = await roundTrip('Projects/Plan.md', text);
      expect(problemOf(stamped)).toBeNull();
      expect(stamped).toContain(`\n${' '.repeat(n)}archived: ${TODAY}\n`);
      expect(back).toBe(text);
    },
  );

  it('the person’s own `archived` key comes back, not removed', async () => {
    const text = indentedNote(2, 'title: Plan', 'archived: false', 'status: open');
    const { back } = await roundTrip('Projects/Plan.md', text);
    expect(propertiesOf(back ?? '')).toMatchObject({ archived: false });
    expect(back).toBe(text);
  });

  it('a stale `archivedFrom` the note carried in comes back, not removed', async () => {
    const text = indentedNote(4, 'archivedFrom: Old/Place.md', 'title: Plan');
    const { back } = await roundTrip('Projects/Plan.md', text);
    expect(back).toBe(text);
  });

  it('guard: CRLF and a byte-order mark round-trip on an indented block', async () => {
    const text = '﻿---\r\n  title: Plan\r\n  status: open\r\n---\r\nBody.\r\n';
    const { stamped, back } = await roundTrip('Projects/Plan.md', text);
    expect(stamped).toContain('\r\n  archived: ');
    expect(back).toBe(text);
  });
});

describe('#394 guards: the other write paths on an indented block', () => {
  const TASK = indentedNote(
    2,
    '# Mara set this up',
    'type: task',
    'status: next-action',
    'tags: [home]',
  );

  it('saveNote with a property change writes it at the indent, every other line kept', async () => {
    const v = vault({ [NOTE]: TASK });
    const opened = await openNote({ fs: v.fs, markdown, path: createVaultPath(NOTE) });
    await saveNote({
      fs: v.fs,
      markdown,
      note: opened,
      doc: opened.doc,
      changes: { values: { status: 'waiting' }, today: TODAY },
    });
    expect(v.text()).toBe(TASK.replace('  status: next-action\n', '  status: waiting\n'));
  });

  it('setNoteProperty (a board move to done) writes status and completed at the indent', async () => {
    const v = vault({ [NOTE]: TASK });
    await setNoteProperty({
      fs: v.fs,
      markdown,
      path: NOTE,
      key: 'status',
      value: 'archive',
      today: TODAY,
    });
    const text = v.text() ?? '';
    expect(problemOf(text)).toBeNull();
    expect(text).toContain('\n  status: archive\n');
    expect(text).toContain(`\n  completed: ${TODAY}\n`);
    expect(text.startsWith('---\n  # Mara set this up\n  type: task\n')).toBe(true);
  });

  it('writeFrontmatterChanges adds and removes keys at the indent', async () => {
    const v = vault({ [NOTE]: TASK });
    await writeFrontmatterChanges({
      fs: v.fs,
      markdown,
      path: NOTE,
      values: { tags: null, owner: '[[Mara Quill]]' },
    });
    expect(v.text()).toBe(TASK.replace('  tags: [home]\n', '  owner: "[[Mara Quill]]"\n'));
  });

  it('a key listed twice (#376) in an indented block: another key writes, the duplicate refuses', async () => {
    const twice = indentedNote(
      2,
      'type: task',
      'status: next-action',
      'tags: [home]',
      'tags: [garden]',
    );
    const v = vault({ [NOTE]: twice });
    await expect(
      setNoteProperty({ fs: v.fs, markdown, path: NOTE, key: 'tags', value: ['x'], today: TODAY }),
    ).rejects.toThrow(FrontmatterRefusedError);
    expect(v.text()).toBe(twice);
    await writeFrontmatterChanges({ fs: v.fs, markdown, path: NOTE, values: { owner: 'Tobias' } });
    expect(v.text()).toBe(
      twice.replace('  tags: [garden]\n', '  tags: [garden]\n  owner: Tobias\n'),
    );
  });

  it('clarify writes the plan at the indent and keeps the lines it does not change', async () => {
    const path = 'Inbox/Call the plumber.md';
    const captured = indentedNote(2, 'type: task', 'status: inbox', 'note: from the hallway');
    const v = vault({ [path]: captured });
    await clarifyInboxItem({
      ports: v.ports,
      path: createVaultPath(path),
      clarification: { status: 'next-action' },
      notePaths: v.notePaths(),
      today: TODAY,
    });
    const written = [...v.files.values()][0] ?? '';
    expect(problemOf(written)).toBeNull();
    expect(propertiesOf(written)).toMatchObject({
      type: 'task',
      status: 'next-action',
      note: 'from the hallway',
    });
    expect(written).toContain('\n  status: next-action\n');
    expect(written).toContain('\n  note: from the hallway\n');
  });

  it('rename-tag rewrites an indented tags list at its own depth', () => {
    const text = indentedNote(4, 'title: Plan', 'tags:', '  - idea', '  - home', 'due: 2026-10-20');
    const renamed = renameTagInNote({ text, markdown, rename: { from: 'idea', to: 'thought' } });
    expect(renamed.problem).toBeNull();
    expect(renamed.text).toBe(text.replace('      - idea\n', '      - thought\n'));
  });

  it('para-migration moves an indented Area onto the Project type at the indent', async () => {
    const garden = indentedNote(2, '# Mara keeps the garden here.', 'type: Area', 'review: weekly');
    const memory = vault({ 'Areas/Garden.md': garden });
    const index = fakeIndexPort({
      query: async () => ({ columns: ['path'], rows: [['Areas/Garden.md']], truncated: false }),
    });
    const ports = { fs: memory.fs, markdown, index };
    const preview = await previewParaMigration(ports);
    await runParaMigration({ ports, panes: { state: () => 'closed', reload: () => {} }, preview });
    expect(memory.text('Areas/Garden.md')).toBe(
      garden
        .replace('  type: Area\n', '  type: project\n')
        .replace('  review: weekly\n', '  review: weekly\n  para: area\n'),
    );
  });

  it('rejecting a proposal stamps it at the indent and keeps its payload lines', async () => {
    const path = 'Inbox/Proposals/Send the file.md';
    const payload = ['payload:', '  title: Send the file', '  due: 2026-10-20'];
    const proposal = indentedNote(2, 'type: proposal', 'kind: task', 'state: open', ...payload);
    const v = vault({ [path]: proposal });
    const rejected = await rejectProposalNote({
      via: 'app',
      ports: v.ports,
      path: createVaultPath(path),
      today: TODAY,
    });
    expect(rejected.archivedAt).toBe(`Archive/${path}`);
    const written = v.text(`Archive/${path}`) ?? '';
    expect(problemOf(written)).toBeNull();
    expect(propertiesOf(written)).toMatchObject({ state: 'rejected', answered_via: 'app' });
    expect(written).toContain('\n  state: rejected\n');
    expect(written).toContain(payload.map((line) => `  ${line}\n`).join(''));
    expect(written).toMatch(/\n {2}answered_via: app\n/);
  });

  it('frontmatter-add puts a new entry under an indented map at its depth', () => {
    const frontmatter = splitFrontmatter(
      indentedNote(2, 'title: Plan', 'links:', '  docs: https://example.com', 'due: 2026-10-20'),
    ).frontmatter!;
    const added = addToFrontmatterMap(frontmatter, 'links', { site: 'https://example.com/site' });
    expect(added).toBe(
      frontmatter.replace(
        '    docs: https://example.com\n',
        '    docs: https://example.com\n    site: https://example.com/site\n',
      ),
    );
  });

  it('frontmatter-add gives an indented block a new map key at the indent', () => {
    const frontmatter = splitFrontmatter(indentedNote(2, 'title: Plan')).frontmatter!;
    const added = addToFrontmatterMap(frontmatter, 'links', { site: 'https://example.com' });
    expect(added).toBe('---\n  title: Plan\n  links:\n    site: https://example.com\n---\n');
  });
});

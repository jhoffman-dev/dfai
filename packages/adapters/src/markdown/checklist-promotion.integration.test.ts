/**
 * P30-03 (integration): promoting a checklist line to a task, through the
 * real markdown reader and writer. What is held: the task is made in its
 * type's home folder, Tasks/<year>/<month> (#214), with the frontmatter the
 * line gives it, the line becomes a link
 * to it and nothing else in the note changes, one undo gives the note back
 * byte for byte and takes the task away, and a refusal leaves both as they
 * were.
 */
import { describe, expect, it, vi } from 'vitest';
import { createVaultPath, parseObjectType, TASK_TYPE_FILE } from '@dfai/domain';
import {
  EntryChangedError,
  fakeVaultFs,
  promoteChecklistLine,
  LineAlreadyPromotedError,
  PromotionRefused,
  undoPromotion,
  UnsavedTypingError,
  type ChecklistLineChoice,
  type PromotionPanes,
  type VaultFsPort,
} from '@dfai/application';
import { remarkMarkdown } from './markdown-port.ts';

const PLAN = [
  '---',
  'type: task',
  'status: in-progress',
  'project: "[[Larkspur launch]]"',
  '---',
  '# Plan the launch',
  '',
  'Intro  kept  as  typed.',
  '',
  '- [x] Book the hall',
  '- [ ] Order chairs',
  '- [ ] Ring Mara Quill ^m4r4q1',
  '',
  'Outro.',
  '',
].join('\n');

const source = createVaultPath('plans/Plan the launch.md');
const today = '2026-10-08';
const closed: PromotionPanes = { state: () => 'closed', reload: vi.fn() };

/** A vault in memory whose writes are checked against the version read, as the host checks them. */
function vault(initial: Record<string, string> = { [source]: PLAN }) {
  let clock = 100;
  const files = new Map(
    Object.entries(initial).map(([path, text]) => [path, { text, modified: (clock += 1) }]),
  );
  const writes: string[] = [];
  const fs = fakeVaultFs({
    readTextFile: async (path) => {
      const file = files.get(path);
      if (file === undefined) throw new Error(`no such file: ${path}`);
      return { ...file };
    },
    writeTextFile: async ({ path, contents, expectedModified }) => {
      if (expectedModified !== null && files.get(path)?.modified !== expectedModified) {
        throw new Error('the note changed on disk since it was opened');
      }
      const modified = (clock += 1);
      files.set(path, { text: contents, modified });
      writes.push(path);
      return modified;
    },
    createNote: async ({ path, contents }) => {
      if (files.has(path)) throw new Error('a note with that name already exists');
      const modified = (clock += 1);
      files.set(path, { text: contents, modified });
      writes.push(path);
      return modified;
    },
    trashEntry: async ({ path }) => {
      if (!files.delete(path)) throw new Error(`no such entry: ${path}`);
    },
  });
  const text = (path: string) => files.get(path)?.text;
  return { fixture: { files, writes }, fs, text };
}

function promote(
  fs: VaultFsPort,
  choice: Partial<ChecklistLineChoice> = {},
  openNotes: PromotionPanes = closed,
) {
  return promoteChecklistLine({
    fs,
    markdown: remarkMarkdown,
    openNotes,
    rng: { next: () => 0.5 },
    today,
    notePaths: [source],
    taskType: TASK_TYPE_FILE.type,
    choice: { source, line: 1, text: 'Order chairs', ...choice },
  });
}

describe('promoting a checklist line', () => {
  it('makes a task in Tasks/<year>/<month>, sourced at the line and filed under the note’s project', async () => {
    const { fs, text } = vault();
    const promotion = await promote(fs);
    expect(promotion.task).toBe('Tasks/2026/10/Order chairs.md');
    const task = text(promotion.task) ?? '';
    expect(task).toContain('type: task\n');
    expect(task).toContain('status: inbox\n');
    expect(task).toMatch(/source: "\[\[Plan the launch#\^([a-z0-9]{6})\]\]"\n/);
    expect(task).toContain('project: "[[Larkspur launch]]"\n');
  });

  it('makes the line a link to the task, with the id its source names, and changes nothing else', async () => {
    const { fs, text } = vault();
    const promotion = await promote(fs);
    const id = /#\^([a-z0-9]{6})/.exec(text(promotion.task) ?? '')?.[1];
    expect(id).toBeDefined();
    expect(text(source)).toBe(
      PLAN.replace('- [ ] Order chairs\n', `- [ ] [[Order chairs]] ^${id ?? ''}\n`),
    );
  });

  it('keeps an id the line already has, and names it as the source', async () => {
    const { fs, text } = vault();
    const promotion = await promote(fs, { line: 2, text: 'Ring Mara Quill' });
    expect(text(promotion.task)).toContain('source: "[[Plan the launch#^m4r4q1]]"\n');
    expect(text(source)).toBe(
      PLAN.replace('- [ ] Ring Mara Quill ^m4r4q1', '- [ ] [[Ring Mara Quill]] ^m4r4q1'),
    );
  });

  it('starts a ticked line finished, dated by the task rules where every new note is made', async () => {
    const { fs, text } = vault();
    const promotion = await promote(fs, { line: 0, text: 'Book the hall' });
    const task = text(promotion.task) ?? '';
    expect(task).toContain('status: archive\n');
    expect(task).toContain(`completed: ${today}\n`);
    expect(text(source)).toContain('- [x] [[Book the hall]] ^');
  });

  it('leaves the status unset in a vault whose Task type is not yet GTD', async () => {
    const { fs, text } = vault();
    const promotion = await promoteChecklistLine({
      fs,
      markdown: remarkMarkdown,
      openNotes: closed,
      rng: { next: () => 0.5 },
      today,
      notePaths: [source],
      taskType: parseObjectType({
        name: 'task',
        properties: { status: { kind: 'select', options: ['backlog', 'next', 'done'] } },
      }),
      choice: { source, line: 1, text: 'Order chairs' },
    });
    expect(text(promotion.task)).not.toContain('status:');
  });

  it("files a line in a project's own note under that project", async () => {
    const project = createVaultPath('Larkspur launch.md');
    const { fs, text } = vault({ [project]: '---\ntype: project\n---\n- [ ] Pick a venue\n' });
    const promotion = await promoteChecklistLine({
      fs,
      markdown: remarkMarkdown,
      openNotes: closed,
      rng: { next: () => 0.5 },
      today,
      notePaths: [project],
      taskType: TASK_TYPE_FILE.type,
      choice: { source: project, line: 0, text: 'Pick a venue' },
    });
    expect(text(promotion.task)).toContain('project: "[[Larkspur launch]]"\n');
  });

  it('numbers the task when the name is taken, and links the line to the one it made', async () => {
    const taken = createVaultPath('Tasks/2026/10/Order chairs.md');
    const { fs, text } = vault({ [source]: PLAN, [taken]: 'Already here.\n' });
    const promotion = await promoteChecklistLine({
      fs,
      markdown: remarkMarkdown,
      openNotes: closed,
      rng: { next: () => 0.5 },
      today,
      notePaths: [source, taken],
      taskType: TASK_TYPE_FILE.type,
      choice: { source, line: 1, text: 'Order chairs' },
    });
    expect(promotion.task).toBe('Tasks/2026/10/Order chairs 2.md');
    expect(text(taken)).toBe('Already here.\n');
    // The line still reads as it did: the link shows its words.
    expect(text(source)).toContain('- [ ] [[Order chairs 2|Order chairs]] ^');
  });

  it('reads the note again in a clean pane holding it', async () => {
    const { fs } = vault();
    const reload = vi.fn();
    await promote(fs, {}, { state: () => 'clean', reload });
    expect(reload).toHaveBeenCalledWith(source);
  });
});

describe('promoting a line that holds more than plain words', () => {
  it('keeps all of it on the line after the link, and writes it into the task too', async () => {
    const note = createVaultPath('Plan.md');
    const line = 'Ring [[Mara Quill]] about #launch, see `notes.md` and **soon**';
    const { fs, text } = vault({ [note]: `- [ ] ${line}\n- [x] Book the hall\n` });
    const words = 'Ring Mara Quill about #launch, see notes.md and soon';
    const promotion = await promote(fs, { source: note, line: 0, text: words });
    expect(text(note)).toMatch(
      new RegExp(
        `^- \\[ \\] \\[\\[${escaped(nameOf(promotion.task))}\\]\\] ${escaped(line)} \\^[a-z0-9]{6}\\n- \\[x\\] Book the hall\\n$`,
      ),
    );
    expect(text(promotion.task)).toMatch(new RegExp(`---\\n${escaped(line)}\\n$`));
  });

  it('keeps a tag a tag — on the line, never inside the link’s alias', async () => {
    const note = createVaultPath('Plan.md');
    const { fs, text } = vault({ [note]: '- [ ] Plan #launch party\n' });
    const promotion = await promote(fs, { source: note, line: 0, text: 'Plan #launch party' });
    expect(text(note)).toMatch(
      /^- \[ \] \[\[Plan launch party\]\] Plan #launch party \^[a-z0-9]{6}\n$/,
    );
    expect(text(promotion.task)).toContain('\nPlan #launch party\n');
  });

  it('writes nothing more into the task for a line of plain words', async () => {
    const { fs, text } = vault();
    const promotion = await promote(fs);
    expect(text(promotion.task)).toMatch(/---\n$/);
  });
});

describe('a line promoted already', () => {
  it('is refused, so a second promotion never makes a second task', async () => {
    const { fs, text } = vault();
    const first = await promote(fs);
    const after = text(source);
    await expect(
      promoteChecklistLine({
        fs,
        markdown: remarkMarkdown,
        openNotes: closed,
        rng: { next: () => 0.5 },
        today,
        notePaths: [source, first.task],
        taskType: TASK_TYPE_FILE.type,
        choice: { source, line: 1, text: 'Order chairs' },
      }),
    ).rejects.toThrow(LineAlreadyPromotedError);
    expect(text(source)).toBe(after);
    expect(text('plans/Order chairs 2.md')).toBeUndefined();
  });

  it('is a line starting with a link to a note that is not a task: that one may be promoted', async () => {
    const mara = createVaultPath('People/Mara Quill.md');
    const note = createVaultPath('Plan.md');
    const { fs, text } = vault({
      [note]: '- [ ] [[Mara Quill]] about the hall\n',
      [mara]: '---\ntype: person\n---\n',
    });
    const promotion = await promoteChecklistLine({
      fs,
      markdown: remarkMarkdown,
      openNotes: closed,
      rng: { next: () => 0.5 },
      today,
      notePaths: [note, mara],
      taskType: TASK_TYPE_FILE.type,
      choice: { source: note, line: 0, text: 'Mara Quill about the hall' },
    });
    expect(text(promotion.task)).toContain('[[Mara Quill]] about the hall');
  });
});

describe('promoting refuses, and changes nothing', () => {
  it('when a pane holds unsaved typing in the note', async () => {
    const { fs, fixture } = vault();
    await expect(promote(fs, {}, { state: () => 'dirty', reload: vi.fn() })).rejects.toThrow(
      UnsavedTypingError,
    );
    expect(fixture.writes).toEqual([]);
  });

  it('when the line no longer says what it was offered with', async () => {
    const { fs, fixture } = vault();
    await expect(promote(fs, { text: 'Order tables' })).rejects.toThrow(PromotionRefused);
    await expect(promote(fs, { line: 9 })).rejects.toThrow(PromotionRefused);
    expect(fixture.writes).toEqual([]);
  });

  it('when the line has no words to name a task by', async () => {
    const empty = createVaultPath('Empty.md');
    const { fs, fixture } = vault({ [empty]: '- [ ] Real\n- [ ]\n' });
    await expect(promote(fs, { source: empty, line: 1, text: '' })).rejects.toThrow(
      'no words to name a task by',
    );
    expect(fixture.writes).toEqual([]);
  });

  it('when the note changes while the task is being made: the task is taken back', async () => {
    const { fs, fixture, text } = vault();
    const edited = PLAN.replace('Outro.', 'Outro, edited elsewhere.');
    const racing: VaultFsPort = {
      ...fs,
      createNote: async (note) => {
        await fs.createNote(note);
        fixture.files.set(source, { text: edited, modified: 999 });
        return 0;
      },
    };
    await expect(promote(racing)).rejects.toThrow('changed while the line was being promoted');
    expect(text('plans/Order chairs.md')).toBeUndefined();
    expect(text(source)).toBe(edited);
  });

  it('when the note changes and the new task is typed in meanwhile: the task is kept (#694)', async () => {
    const { fs, fixture, text } = vault();
    let task = '';
    const racing: VaultFsPort = {
      ...fs,
      createNote: async (note) => {
        const made = await fs.createNote(note);
        task = note.path;
        fixture.files.set(note.path, { text: `${note.contents}Typed.\n`, modified: made });
        fixture.files.set(source, { text: `${PLAN}Edited elsewhere.\n`, modified: 999 });
        return made;
      },
    };
    await expect(promote(racing)).rejects.toThrow('could not be taken back');
    expect(text(task)).toMatch(/Typed\.\n$/);
  });

  it('when the note changes and the new task is typed in just before its trash: the task is kept (#694)', async () => {
    const { fs, fixture, text } = vault();
    let task = '';
    const racing: VaultFsPort = {
      ...fs,
      createNote: async (note) => {
        const made = await fs.createNote(note);
        task = note.path;
        fixture.files.set(source, { text: `${PLAN}Edited elsewhere.\n`, modified: 999 });
        return made;
      },
      // Typing lands between the take-back's check and its trash; the Trash holds, as the host's does.
      trashEntry: async (args) => {
        const now = fixture.files.get(args.path)!;
        fixture.files.set(args.path, { text: `${now.text}Typed.\n`, modified: now.modified + 1 });
        for (const held of args.unchanged ?? []) {
          const file = fixture.files.get(held.path);
          if (file?.text !== held.text || file.modified !== held.modified) {
            throw new EntryChangedError(`${held.path} changed`);
          }
        }
        await fs.trashEntry(args);
      },
    };
    await expect(promote(racing)).rejects.toThrow('could not be taken back');
    expect(text(task)).toMatch(/Typed\.\n$/);
  });

  it('when typing begins in a pane while the task is being made: the task is taken back', async () => {
    const { fs, text } = vault();
    let asked = 0;
    const typing: PromotionPanes = {
      state: () => (asked++ === 0 ? 'closed' : 'dirty'),
      reload: vi.fn(),
    };
    await expect(promote(fs, {}, typing)).rejects.toThrow(UnsavedTypingError);
    expect(text('plans/Order chairs.md')).toBeUndefined();
    expect(text(source)).toBe(PLAN);
  });
});

describe('undoing a promotion', () => {
  it('gives the note back byte for byte and takes the task away, in one step', async () => {
    const { fs, text } = vault();
    const promotion = await promote(fs);
    await undoPromotion({ fs, openNotes: closed, promotion });
    expect(text(source)).toBe(PLAN);
    expect(text(promotion.task)).toBeUndefined();
  });

  it('refuses, changing neither, when the note was written since', async () => {
    const { fs, fixture, text } = vault();
    const promotion = await promote(fs);
    const since = `${text(source) ?? ''}More.\n`;
    fixture.files.set(source, { text: since, modified: 999 });
    await expect(undoPromotion({ fs, openNotes: closed, promotion })).rejects.toThrow(
      'changed since the line was promoted',
    );
    expect(text(source)).toBe(since);
    expect(text(promotion.task)).toBeDefined();
  });

  it('refuses, changing neither, when the task was written since', async () => {
    const { fs, fixture, text } = vault();
    const promotion = await promote(fs);
    const promoted = text(source);
    fixture.files.set(promotion.task, { text: 'Worked on.\n', modified: 999 });
    await expect(undoPromotion({ fs, openNotes: closed, promotion })).rejects.toThrow(
      PromotionRefused,
    );
    expect(text(source)).toBe(promoted);
    expect(text(promotion.task)).toBe('Worked on.\n');
  });

  it('refuses while a pane holds unsaved typing in either', async () => {
    const { fs, text } = vault();
    const promotion = await promote(fs);
    const typingIn = (path: string): PromotionPanes => ({
      state: (held) => (held === path ? 'dirty' : 'closed'),
      reload: vi.fn(),
    });
    for (const path of [source, promotion.task]) {
      await expect(undoPromotion({ fs, openNotes: typingIn(path), promotion })).rejects.toThrow(
        UnsavedTypingError,
      );
    }
    expect(text(promotion.task)).toBeDefined();
  });
});

// A list written with `*` or numbers is written back with `-` once any line
// of it changes — as typing in it does — since the editor's checklist has
// one spelling (ADR-0003). These are the spellings it keeps byte for byte.
describe('the rest of the checklist keeps its bytes', () => {
  it.each([
    [
      'nested under another',
      '- [ ] Plan\n  - [ ] Order chairs\n  - [x] Book the hall\n',
      '  - [ ] [[Order chairs]] ^',
    ],
    ['quoted', '> - [ ] Order chairs\n> - [x] Book the hall\n', '> - [ ] [[Order chairs]] ^'],
  ])('%s', async (_name, body, promoted) => {
    const note = createVaultPath('Note.md');
    const { fs, text } = vault({ [note]: body });
    const line = body.startsWith('- [ ] Plan') ? 1 : 0;
    await promote(fs, { source: note, line, text: 'Order chairs' });
    const after = text(note) ?? '';
    expect(after).toContain(promoted);
    const others = body.split('\n').filter((row) => !row.includes('Order chairs'));
    for (const row of others) expect(after.split('\n')).toContain(row);
  });
});

function escaped(words: string): string {
  return words.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The note's name, as a link to a note no other shares a name with is written. */
function nameOf(path: string): string {
  return (path.split('/').at(-1) ?? path).slice(0, -'.md'.length);
}

/**
 * Second attack on PR #694 (a130f389): a Promotion now holds the task to
 * `taskText`, the text promoteChecklistLine *asked* createNote to write. But
 * createNote holds a new note to the task rules (ADR-0029) and, for a ticked
 * line (status archive), adds `completed: <today>` before writing. The text on
 * disk is then never `taskText`, so every check against it fails.
 *
 * The vault here is held the way the host holds it: a write naming
 * `expectedText` and a trash naming `unchanged` are refused on other bytes.
 */
import { describe, expect, it, vi } from 'vitest';
import { createVaultPath, TASK_TYPE_FILE } from '@dfai/domain';
import {
  EntryChangedError,
  fakeVaultFs,
  promoteChecklistLine,
  undoPromotion,
  type ChecklistLineChoice,
  type PromotionPanes,
  type VaultFsPort,
} from '@dfai/application';
import { remarkMarkdown } from './markdown-port.ts';

const PLAN = ['# Plan the launch', '', '- [x] Book the hall', '- [ ] Order chairs', ''].join('\n');

const source = createVaultPath('plans/Plan the launch.md');
const today = '2026-10-08';
const closed: PromotionPanes = { state: () => 'closed', reload: vi.fn() };

function hostLikeVault() {
  let clock = 100;
  const files = new Map<string, { text: string; modified: number }>([
    [source, { text: PLAN, modified: (clock += 1) }],
  ]);
  const fs = fakeVaultFs({
    readTextFile: async (path) => {
      const file = files.get(path);
      if (file === undefined) throw new Error(`no such file: ${path}`);
      return { ...file };
    },
    writeTextFile: async ({ path, contents, expectedModified, expectedText }) => {
      const file = files.get(path);
      if (expectedModified !== null && file?.modified !== expectedModified) {
        throw new Error('the note changed on disk since it was opened');
      }
      if (expectedText !== undefined && file?.text !== expectedText) {
        throw new Error('the note changed on disk since it was opened');
      }
      const modified = (clock += 1);
      files.set(path, { text: contents, modified });
      return modified;
    },
    createNote: async ({ path, contents }) => {
      if (files.has(path)) throw new Error('a note with that name already exists');
      const modified = (clock += 1);
      files.set(path, { text: contents, modified });
      return modified;
    },
    trashEntry: async ({ path, unchanged = [] }) => {
      for (const held of unchanged) {
        const file = files.get(held.path);
        if (file?.text !== held.text || file.modified !== held.modified) {
          throw new EntryChangedError(`${held.path} changed`);
        }
      }
      if (!files.delete(path)) throw new Error(`no such entry: ${path}`);
    },
  });
  return { fs, files, text: (path: string) => files.get(path)?.text };
}

function promoteTicked(fs: VaultFsPort, choice: Partial<ChecklistLineChoice> = {}) {
  return promoteChecklistLine({
    fs,
    markdown: remarkMarkdown,
    openNotes: closed,
    rng: { next: () => 0.5 },
    today,
    notePaths: [source],
    taskType: TASK_TYPE_FILE.type,
    choice: { source, line: 0, text: 'Book the hall', ...choice },
  });
}

describe('a ticked line promoted (createNote dates it completed) — attack 2 on #694', () => {
  it('probe: the task on disk is not the taskText the Promotion holds', async () => {
    const { fs, text } = hostLikeVault();
    const promotion = await promoteTicked(fs);
    expect(text(promotion.task)).toContain(`completed: ${today}\n`);
    expect(promotion.taskText).not.toContain('completed:');
    expect(text(promotion.task)).not.toBe(promotion.taskText);
  });

  it.fails('can be undone when nothing has changed since', async () => {
    const { fs, text } = hostLikeVault();
    const promotion = await promoteTicked(fs);
    // Observed: PromotionRefused "Book the hall changed since the line was promoted".
    await undoPromotion({ fs, openNotes: closed, promotion });
    expect(text(source)).toBe(PLAN);
    expect(text(promotion.task)).toBeUndefined();
  });

  it.fails(
    'a refused promotion takes its untouched task back rather than orphaning it',
    async () => {
      const vault = hostLikeVault();
      let made = '';
      const racing: VaultFsPort = {
        ...vault.fs,
        createNote: async (note) => {
          const modified = await vault.fs.createNote(note);
          made = note.path;
          // The source moves on while the task is being made, so the save is refused.
          vault.files.set(source, { text: `${PLAN}Edited elsewhere.\n`, modified: 999 });
          return modified;
        },
      };
      // Observed: AggregateError "... could not be taken back", task left in the vault
      // although nobody touched it: takeBack compares against the pre-rules text.
      await expect(promoteTicked(racing)).rejects.toThrow(
        'changed while the line was being promoted',
      );
      expect(made).not.toBe('');
      expect(vault.text(made)).toBeUndefined();
    },
  );
});

function promoteOpen(fs: VaultFsPort) {
  return promoteTicked(fs, { line: 1, text: 'Order chairs' });
}

describe('undoing an open line’s promotion under races — attack 2 on #694 (probes)', () => {
  it('source edited between the check and the line write: task in Trash, line kept, message says so; a retry changes nothing', async () => {
    const vault = hostLikeVault();
    const promotion = await promoteOpen(vault.fs);
    const promoted = vault.text(source);
    const edited = `${promoted}Typed after the check.\n`;
    const racing: VaultFsPort = {
      ...vault.fs,
      trashEntry: async (args) => {
        await vault.fs.trashEntry(args);
        const now = vault.files.get(source)!;
        vault.files.set(source, { text: edited, modified: now.modified });
      },
    };
    await expect(undoPromotion({ fs: racing, openNotes: closed, promotion })).rejects.toThrow(
      /went to the Trash, but its line was not put back.*Put the task back from the Trash/,
    );
    expect(vault.text(source)).toBe(edited);
    expect(vault.text(promotion.task)).toBeUndefined();

    await expect(undoPromotion({ fs: vault.fs, openNotes: closed, promotion })).rejects.toThrow(
      /changed since/,
    );
    expect(vault.text(source)).toBe(edited);
  });

  it('task restored from the Trash (same bytes, same time) then undo retried: line put back, task trashed once more', async () => {
    const vault = hostLikeVault();
    const promotion = await promoteOpen(vault.fs);
    const task = vault.files.get(promotion.task)!;
    const failingOnce: VaultFsPort = {
      ...vault.fs,
      writeTextFile: async () => {
        throw new Error('disk full');
      },
    };
    await expect(undoPromotion({ fs: failingOnce, openNotes: closed, promotion })).rejects.toThrow(
      /disk full/,
    );
    vault.files.set(promotion.task, { ...task });
    await undoPromotion({ fs: vault.fs, openNotes: closed, promotion });
    expect(vault.text(source)).toBe(PLAN);
    expect(vault.text(promotion.task)).toBeUndefined();
  });

  it('two promotions from one note: undoing the first after the second is refused, both kept', async () => {
    const vault = hostLikeVault();
    const first = await promoteOpen(vault.fs);
    const second = await promoteChecklistLine({
      fs: vault.fs,
      markdown: remarkMarkdown,
      openNotes: closed,
      rng: { next: () => 0.25 },
      today,
      notePaths: [source, first.task],
      taskType: null,
      choice: { source, line: 0, text: 'Book the hall' },
    });
    const both = vault.text(source);
    await expect(
      undoPromotion({ fs: vault.fs, openNotes: closed, promotion: first }),
    ).rejects.toThrow(/changed since/);
    expect(vault.text(source)).toBe(both);
    expect(vault.text(first.task)).toBeDefined();
    await undoPromotion({ fs: vault.fs, openNotes: closed, promotion: second });
    expect(vault.text(second.task)).toBeUndefined();
  });

  it('a Promotion without sourceText/taskText (shape before a130f389) is refused with nothing trashed', async () => {
    const vault = hostLikeVault();
    const promotion = await promoteOpen(vault.fs);
    const older: Record<string, unknown> = { ...promotion };
    delete older['sourceText'];
    delete older['taskText'];
    const promoted = vault.text(source);
    await expect(
      undoPromotion({ fs: vault.fs, openNotes: closed, promotion: older as never }),
    ).rejects.toThrow(/changed since/);
    expect(vault.text(source)).toBe(promoted);
    expect(vault.text(promotion.task)).toBeDefined();
  });
});

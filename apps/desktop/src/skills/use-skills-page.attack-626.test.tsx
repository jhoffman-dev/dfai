// @vitest-environment jsdom
/**
 * Attack on PR #626 (#169): the Skills page's editor as a state machine,
 * raced against the vault. Each `it` names the one invariant it holds the
 * hook to; the seeded walk at the end drives random sequences and checks
 * every invariant after each step.
 */
import { describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createVaultPath, parentVaultPath, vaultPathName, type VaultEntry } from '@dfai/domain';
import { fakeVaultFs, VaultAccessError } from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { readAgain, vaultReadKey } from '../reads/query-client.ts';
import { queryWrapper } from '../reads/query-wrapper.tsx';
import { useSkillsPage, type SkillOverlay } from './use-skills-page.ts';

const VAULT = '/vaults/larkspur';
const skillText = (name: string, description = 'Does a thing.') =>
  ['---', `name: ${name}`, `description: ${description}`, '---', '', 'Step one.', ''].join('\n');
const pathOf = (name: string) => `.atlas/skills/${name}/SKILL.md`;

/** A gate: `wait` holds until `open` is called. */
function gate() {
  let open = () => {};
  const wait = new Promise<void>((done) => {
    open = done;
  });
  return { wait, open };
}

/** The vault in memory, refusing as the host does, with writes and the Trash held on request. */
function memoryVault(files: Record<string, string>) {
  let clock = 10;
  const notes = new Map(Object.entries(files).map(([path, text]) => [path, { text, modified: 1 }]));
  const dirs = new Set<string>();
  const trashed: string[] = [];
  const written: string[] = [];
  const controls = {
    holdWrite: null as Promise<void> | null,
    holdTrash: null as Promise<void> | null,
    refuseRead: new Set<string>(),
  };
  const folders = () => {
    const found = new Set(dirs);
    for (const path of [...notes.keys(), ...dirs]) {
      for (let at = parentVaultPath(createVaultPath(path)) as string; at !== '';) {
        found.add(at);
        at = parentVaultPath(createVaultPath(at));
      }
    }
    return found;
  };
  const entry = (kind: VaultEntry['kind'], path: string) =>
    ({
      kind,
      name: vaultPathName(createVaultPath(path)),
      path: createVaultPath(path),
    }) as VaultEntry;
  const fs = fakeVaultFs({
    listDirectory: async (folder) => {
      if (folder !== '' && !folders().has(folder)) throw new VaultAccessError('no such folder');
      const under = (path: string) => parentVaultPath(createVaultPath(path)) === folder;
      return [
        ...[...folders()].filter(under).map((path) => entry('directory', path)),
        ...[...notes.keys()].filter(under).map((path) => entry('file', path)),
      ];
    },
    readTextFile: async (path) => {
      const note = notes.get(path);
      if (note === undefined || controls.refuseRead.has(path)) {
        throw new VaultAccessError('no such file');
      }
      return note;
    },
    createFolder: async ({ path }) => {
      dirs.add(path);
    },
    createNote: async ({ path, contents }) => {
      await controls.holdWrite;
      if (notes.has(path)) throw new VaultAccessError('already there');
      clock += 1;
      notes.set(path, { text: contents, modified: clock });
      written.push(path);
      return clock;
    },
    writeTextFile: async ({ path, contents, expectedModified }) => {
      await controls.holdWrite;
      if (notes.get(path)?.modified !== expectedModified) {
        throw new VaultAccessError('the note changed on disk since it was opened');
      }
      clock += 1;
      notes.set(path, { text: contents, modified: clock });
      written.push(path);
      return clock;
    },
    trashEntry: async ({ path }) => {
      await controls.holdTrash;
      trashed.push(path);
      for (const key of [...notes.keys()]) if (key.startsWith(`${path}/`)) notes.delete(key);
      for (const key of [...dirs]) if (key === path || key.startsWith(`${path}/`)) dirs.delete(key);
    },
  });
  const writeOnDisk = (path: string, text: string) => {
    clock += 1;
    notes.set(path, { text, modified: clock });
  };
  const deleteOnDisk = (path: string) => {
    notes.delete(path);
    dirs.delete(parentVaultPath(createVaultPath(path)));
  };
  return { fs, notes, trashed, written, controls, writeOnDisk, deleteOnDisk };
}

function renderPage(files: Record<string, string>) {
  const vault = memoryVault(files);
  const { client, wrapper } = queryWrapper();
  const view = renderHook(
    () => {
      const [up, setUp] = useState<SkillOverlay | null>(null);
      const page = useSkillsPage({
        ports: {
          fs: vault.fs,
          markdown: remarkMarkdown,
          overlay: {
            show: (which) => setUp(which),
            hide: (which) => setUp((was) => (was === which ? null : was)),
          },
        },
        overlayUp: up,
        vault: VAULT,
        onOpenNote: vi.fn(),
      });
      return { page, up };
    },
    { wrapper },
  );
  const changedOnDisk = () => act(() => readAgain(client, vaultReadKey(VAULT, 'skills')));
  const now = () => view.result.current.page;
  return { ...view, ...vault, now, up: () => view.result.current.up, changedOnDisk };
}

async function open(page: ReturnType<typeof renderPage>, name: string) {
  await waitFor(() => expect(page.now().skills.items?.map((skill) => skill.name)).toContain(name));
  act(() => page.now().onSelect(name));
  await waitFor(() => expect(page.now().editor?.draft.name).toBe(name));
}

/** Lets every pending promise and query settle. */
const settle = () => act(async () => new Promise((done) => setTimeout(done, 0)));

describe('Skills page editor, attacked (#626)', () => {
  it('a delete that finishes after another skill was opened keeps the typing in that skill', async () => {
    const page = renderPage({
      [pathOf('weekly-review')]: skillText('weekly-review'),
      [pathOf('meeting-notes')]: skillText('meeting-notes'),
    });
    await open(page, 'weekly-review');
    act(() => page.now().onDelete());
    await waitFor(() => expect(page.now().deleteQuestion).not.toBeNull());
    const trash = gate();
    page.controls.holdTrash = trash.wait;
    act(() => page.now().deleteQuestion?.onConfirm());
    // The Trash is slow; the person moves on and types into another skill.
    await open(page, 'meeting-notes');
    act(() => page.now().onChange({ instructions: 'Typed while the Trash ran.' }));

    await act(async () => trash.open());
    await settle();
    expect(page.trashed).toEqual(['.atlas/skills/weekly-review']);
    expect(page.now().selected).toBe('meeting-notes');
    expect(page.now().editor?.draft.instructions).toBe('Typed while the Trash ran.');
  });

  it('a delete that finishes after another skill was opened sends no focus away from it', async () => {
    const page = renderPage({
      [pathOf('alpha')]: skillText('alpha'),
      [pathOf('meeting-notes')]: skillText('meeting-notes'),
    });
    await open(page, 'alpha');
    act(() => page.now().onDelete());
    await waitFor(() => expect(page.now().deleteQuestion).not.toBeNull());
    const trash = gate();
    page.controls.holdTrash = trash.wait;
    act(() => page.now().deleteQuestion?.onConfirm());
    await open(page, 'meeting-notes');
    await act(async () => trash.open());
    await settle();
    expect(page.now().focusTarget).toBeNull();
  });

  it('leaves no overlay up with nothing drawn when Delete is pressed again while the Trash runs', async () => {
    const page = renderPage({ [pathOf('weekly-review')]: skillText('weekly-review') });
    await open(page, 'weekly-review');
    act(() => page.now().onDelete());
    await waitFor(() => expect(page.now().deleteQuestion).not.toBeNull());
    const trash = gate();
    page.controls.holdTrash = trash.wait;
    act(() => page.now().deleteQuestion?.onConfirm());
    // The editor is still drawn, Delete with it, but off while the Trash runs: one delete at
    // a time (the coordinator's call on the fix). Pressed anyway, it asks nothing.
    expect(page.now().editor?.mode).toBe('edit');
    expect(page.now().editor?.deleting).toBe(true);
    act(() => page.now().onDelete());
    await settle();
    expect(page.up()).toBeNull();

    await act(async () => trash.open());
    await settle();
    const drawn = page.now().deleteQuestion !== null;
    expect(drawn || page.up() === null).toBe(true);
  });

  it('a delete that finishes after New was pressed keeps the new skill’s typing', async () => {
    const page = renderPage({ [pathOf('weekly-review')]: skillText('weekly-review') });
    await open(page, 'weekly-review');
    act(() => page.now().onDelete());
    await waitFor(() => expect(page.now().deleteQuestion).not.toBeNull());
    const trash = gate();
    page.controls.holdTrash = trash.wait;
    act(() => page.now().deleteQuestion?.onConfirm());
    act(() => page.now().onNew());
    act(() => page.now().onChange({ name: 'morning-plan', instructions: 'Plan the day.' }));

    await act(async () => trash.open());
    await settle();
    expect(page.now().editor?.mode).toBe('new');
    expect(page.now().editor?.draft.instructions).toBe('Plan the day.');
  });

  it('leaves no overlay up with nothing drawn when the skill is deleted on disk under the delete question', async () => {
    const page = renderPage({ [pathOf('weekly-review')]: skillText('weekly-review') });
    await open(page, 'weekly-review');
    act(() => page.now().onDelete());
    await waitFor(() => expect(page.now().deleteQuestion).not.toBeNull());
    expect(page.up()).toBe('skill-delete');

    page.deleteOnDisk(pathOf('weekly-review'));
    await page.changedOnDisk();
    await settle();
    // Either the question is still drawn, or the overlay it held is down.
    const drawn = page.now().deleteQuestion !== null;
    expect(drawn || page.up() === null).toBe(true);
  });

  it('opens a skill again by clicking it after it was deleted on disk and made again', async () => {
    const page = renderPage({ [pathOf('weekly-review')]: skillText('weekly-review') });
    await open(page, 'weekly-review');
    page.deleteOnDisk(pathOf('weekly-review'));
    await page.changedOnDisk();
    await waitFor(() => expect(page.now().editor).toBeNull());

    page.writeOnDisk(pathOf('weekly-review'), skillText('weekly-review', 'Made again.'));
    await page.changedOnDisk();
    await waitFor(() =>
      expect(page.now().skills.items?.map((skill) => skill.name)).toEqual(['weekly-review']),
    );
    act(() => page.now().onSelect('weekly-review'));
    await settle();
    expect(page.now().editor?.draft.description).toBe('Made again.');
  });

  it('marks no skill selected once the open one is gone from disk and its editor closed', async () => {
    const page = renderPage({ [pathOf('weekly-review')]: skillText('weekly-review') });
    await open(page, 'weekly-review');
    page.deleteOnDisk(pathOf('weekly-review'));
    await page.changedOnDisk();
    await waitFor(() => expect(page.now().editor).toBeNull());
    expect(page.now().selected).toBeNull();
  });

  it('keeps Save off for a skill whose SKILL.md cannot be read, which no save can write', async () => {
    const page = renderPage({ [pathOf('weekly-review')]: skillText('weekly-review') });
    page.controls.refuseRead.add(pathOf('weekly-review'));
    await open(page, 'weekly-review');
    act(() => page.now().onChange({ description: 'Typed over.', instructions: 'Typed over too.' }));
    expect(page.now().editor?.problems).toEqual([]);
    // The save it offers is refused: nothing is saved over a file that cannot be read.
    act(() => page.now().onSave());
    await waitFor(() => expect(page.now().notice).toMatch(/could not be saved/));
    expect(page.now().editor?.canSave).toBe(false);
  });

  it('keeps Save off for a skill whose frontmatter cannot be read, which no save can write', async () => {
    const broken = ['---', 'name: weekly-review', 'description: [unclosed', '---', '', 'Step.', ''];
    const page = renderPage({ [pathOf('weekly-review')]: broken.join('\n') });
    await open(page, 'weekly-review');
    act(() => page.now().onChange({ description: 'Fixed here.' }));
    expect(page.now().editor?.problems).toEqual([]);
    act(() => page.now().onSave());
    await waitFor(() => expect(page.now().notice).toMatch(/could not be saved/));
    expect(page.written).toEqual([]);
    expect(page.now().editor?.canSave).toBe(false);
  });

  it('offers Reload when the file changes on disk between the save’s check and its write', async () => {
    const page = renderPage({ [pathOf('weekly-review')]: skillText('weekly-review') });
    await open(page, 'weekly-review');
    act(() => page.now().onChange({ instructions: 'Mine.' }));
    const write = gate();
    page.controls.holdWrite = write.wait;
    act(() => page.now().onSave());
    // The use-case has read SKILL.md and is waiting on the write; another program writes.
    await settle();
    page.writeOnDisk(pathOf('weekly-review'), skillText('weekly-review', 'Theirs.'));
    await act(async () => write.open());
    await settle();
    expect(page.now().editor?.draft.instructions).toBe('Mine.');
    expect(page.now().editor?.changedOnDisk).toBe(true);
    expect(page.now().editor?.canSave).toBe(false);
  });
});

/* ---------- The seeded walk ---------- */

function mulberry32(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NAMES = ['alpha', 'bravo', 'charlie'] as const;
const STEPS = [
  'select',
  'type',
  'save',
  'holdWrites',
  'releaseWrites',
  'holdTrash',
  'releaseTrash',
  'diskChange',
  'diskDelete',
  'diskCreate',
  'reload',
  'delete',
  'confirm',
  'cancel',
  'keep',
  'discard',
  'close',
  'new',
] as const;
const MODAL_STEPS = [
  'confirm',
  'cancel',
  'keep',
  'discard',
  'diskChange',
  'diskDelete',
  'diskCreate',
  'holdWrites',
  'releaseWrites',
  'holdTrash',
  'releaseTrash',
] as const;

/**
 * One random walk. Returns the first invariant broken, or null. The typing
 * model: `typed` is what the person last typed into `typedIn`; only their
 * own Discard, Reload, Delete of that same skill, or a save of it may make
 * the editor stop holding it.
 */
async function walk(seed: number, length: number): Promise<string | null> {
  const random = mulberry32(seed);
  const pick = <T,>(items: readonly T[]) => items[Math.floor(random() * items.length)] as T;
  const page = renderPage(Object.fromEntries(NAMES.map((name) => [pathOf(name), skillText(name)])));
  await settle();
  let typed: { readonly in: string | null; readonly text: string } | null = null;
  let releaseWrite: (() => void) | null = null;
  let releaseTrash: (() => void) | null = null;
  const saves: { forPath: string }[] = [];
  const trail: string[] = [];
  try {
    for (let step = 0; step < length; step += 1) {
      const p = page.now();
      // A question up is modal: the page behind it takes no clicks, only the disk moves.
      const modal = p.deleteQuestion !== null || p.discardQuestion !== null;
      const what = pick(modal ? MODAL_STEPS : STEPS);
      const where = p.selected;
      trail.push(what);
      let forgiven = false;
      switch (what) {
        case 'select':
          act(() => p.onSelect(pick(NAMES)));
          break;
        case 'type':
          if (p.editor !== null && !p.editor.saving) {
            const text = `typed ${step}`;
            act(() => p.onChange({ instructions: text }));
            typed = { in: where, text };
          }
          break;
        case 'save':
          if (p.editor?.canSave === true && where !== null) {
            saves.push({ forPath: pathOf(where) });
            act(() => p.onSave());
            forgiven = true;
          }
          break;
        case 'holdWrites':
          if (releaseWrite === null) {
            const held = gate();
            page.controls.holdWrite = held.wait;
            releaseWrite = held.open;
          }
          break;
        case 'releaseWrites':
          page.controls.holdWrite = null;
          if (releaseWrite !== null) await act(async () => releaseWrite?.());
          releaseWrite = null;
          forgiven = true;
          break;
        case 'holdTrash':
          if (releaseTrash === null) {
            const held = gate();
            page.controls.holdTrash = held.wait;
            releaseTrash = held.open;
          }
          break;
        case 'releaseTrash':
          page.controls.holdTrash = null;
          if (releaseTrash !== null) await act(async () => releaseTrash?.());
          releaseTrash = null;
          break;
        case 'diskChange': {
          const name = pick(NAMES);
          if (page.notes.has(pathOf(name))) {
            page.writeOnDisk(pathOf(name), skillText(name, `Changed at ${step}.`));
            await page.changedOnDisk();
          }
          break;
        }
        case 'diskDelete':
          page.deleteOnDisk(pathOf(pick(NAMES)));
          await page.changedOnDisk();
          break;
        case 'diskCreate': {
          const name = pick(NAMES);
          if (!page.notes.has(pathOf(name))) {
            page.writeOnDisk(pathOf(name), skillText(name, `Made at ${step}.`));
            await page.changedOnDisk();
          }
          break;
        }
        case 'reload':
          if (p.editor?.changedOnDisk === true) {
            act(() => p.onReload());
            forgiven = true;
          }
          break;
        case 'delete':
          if (p.editor?.mode === 'edit') act(() => p.onDelete());
          break;
        case 'confirm':
          if (p.deleteQuestion !== null) {
            act(() => p.deleteQuestion?.onConfirm());
            // Deleting the skill typed in is the person's own act.
            if (typed?.in === where) typed = null;
          }
          break;
        case 'cancel':
          act(() => p.deleteQuestion?.onCancel());
          break;
        case 'keep':
          act(() => p.discardQuestion?.onKeep());
          break;
        case 'discard':
          if (p.discardQuestion !== null) {
            act(() => p.discardQuestion?.onDiscard());
            forgiven = true;
          }
          break;
        case 'close':
          act(() => p.onClose());
          break;
        case 'new':
          act(() => p.onNew());
          break;
      }
      await settle();
      const after = page.now();
      const up = page.up();
      // No overlay is left up with nothing drawn for it.
      if (up === 'skill-delete' && after.deleteQuestion === null) {
        return `stuck delete overlay after ${trail.slice(-4).join(', ')}`;
      }
      if (up === 'skill-discard' && after.discardQuestion === null) {
        return `stuck discard overlay after ${trail.slice(-4).join(', ')}`;
      }
      // Every write went to a skill a save was made for.
      for (const path of page.written) {
        if (!saves.some((save) => save.forPath === path) && !path.includes('/untitled')) {
          return `a write to ${path} that no save was for`;
        }
      }
      // Typing is never lost without the person's say-so.
      if (typed !== null && !forgiven) {
        const holds =
          after.selected === typed.in && after.editor?.draft.instructions === typed.text;
        if (!holds) return `typing in ${typed.in} lost after ${trail.slice(-4).join(', ')}`;
      }
      if (forgiven) typed = null;
    }
    return null;
  } finally {
    if (releaseWrite !== null) releaseWrite();
    if (releaseTrash !== null) releaseTrash();
    page.unmount();
  }
}

describe('Skills page editor, seeded walk (#626)', () => {
  it('keeps every invariant over 120 seeded walks of 60 steps', async () => {
    const broken: string[] = [];
    for (let seed = 1; seed <= 120; seed += 1) {
      const found = await walk(seed, 60);
      if (found !== null) broken.push(`seed ${seed}: ${found}`);
    }
    expect(broken).toEqual([]);
  }, 120_000);
});

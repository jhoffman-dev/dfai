/**
 * Attack on PR #612 (#225): a clarification and its undo, over a seeded run of
 * requests and the faults a vault meets — a move refused, a write refused, a
 * stamp refused once moved, a name already taken, the project or the note
 * changed by sync meanwhile. Fictional data only.
 *
 * The invariants, one per test:
 * - a clarification that rejects has changed nothing (the Inbox offers no undo for it);
 * - `clarifiedAnything` is true exactly when the vault differs from before;
 * - undo puts back exactly what changed and nothing else;
 * - an edit another editor saved after the clarification's write survives the undo.
 */
import { describe, expect, it } from 'vitest';
import { createVaultPath, type Clarification } from '@dfai/domain';
import type { ArchivePorts } from '../archive/archive-notes.ts';
import { memoryVault } from '../testing/fake-git.ts';
import { fakeIndexPort, fakeMarkdown, fakeVaultFs } from '../testing/fake-ports.ts';
import {
  clarifiedAnything,
  clarifyInboxItem,
  undoClarifyInboxItem,
  type ClarifyOutcome,
} from './clarify-inbox-item.ts';

const TODAY = '2026-10-11';
const PROJECT = 'Projects/Larkspur.md';
const CALL = 'Inbox/Call the florist.md';
const FILED = 'Tasks/2026/10/Call the florist.md';
const TASK = '---\ntype: task\nstatus: inbox\n---\n\nAbout the tulips.\n';
const PLAIN = 'Ask about the tulips.\n';
const BASE = {
  [PROJECT]: '---\ntype: project\nstatus: active\n---\n\n# Larkspur\n',
  'People/Wren Ashby.md': '---\ntype: person\n---\n',
};

type Fault =
  | 'none'
  | 'move refused'
  | 'text write refused'
  | 'stamp refused'
  | 'name taken'
  | 'project gone meanwhile'
  | 'edited after write';

/** A vault in memory, with one fault switched on. */
function vault(note: string, fault: Fault) {
  const memory = memoryVault({
    ...BASE,
    [CALL]: note,
    ...(fault === 'name taken' && { [FILED]: '---\ntype: task\nstatus: done\n---\n' }),
  });
  let written = false;
  let refusedOnce = false;
  const ports: ArchivePorts = {
    fs: fakeVaultFs({
      ...memory.fs,
      moveEntry: async (move) => {
        if (fault === 'move refused') throw new Error('The disk is full.');
        return memory.fs.moveEntry(move);
      },
      writeTextFile: async (write) => {
        if (fault === 'text write refused' && write.path === CALL && !refusedOnce) {
          refusedOnce = true; // Once: the disk is busy, then it is not.
          throw new Error('Permission denied.');
        }
        if (fault === 'stamp refused' && write.path.startsWith('Tasks/')) {
          throw new Error('Permission denied.');
        }
        const result = await memory.fs.writeTextFile(write);
        if (!written) {
          written = true;
          // Sync, between the clarification's write and what it does next.
          if (fault === 'project gone meanwhile') memory.files.delete(PROJECT);
          if (fault === 'edited after write') {
            memory.files.set(write.path, `${write.contents}Typed on the other Mac.\n`);
          }
        }
        return result;
      },
    }),
    markdown: fakeMarkdown(),
    index: fakeIndexPort(),
    editors: {
      state: () => 'closed',
      flush: async () => {},
      follow: () => {},
      abandon: () => {},
      reload: () => {},
    },
  };
  const notePaths = () => [...memory.files.keys()].map((at) => createVaultPath(at));
  return {
    files: memory.files,
    snapshot: () => new Map(memory.files),
    clarify: (clarification: Clarification) =>
      clarifyInboxItem({
        ports,
        path: createVaultPath(CALL),
        clarification,
        notePaths: notePaths(),
        today: TODAY,
      }),
    undo: (outcome: ClarifyOutcome) =>
      undoClarifyInboxItem({ ports, undo: outcome.undo, notePaths: notePaths() }),
  };
}

/** mulberry32: the same seed, the same run. */
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

const project = createVaultPath(PROJECT);
const REQUESTS: readonly { note: string; clarification: Clarification }[] = [
  { note: TASK, clarification: { status: 'next-action' } },
  { note: TASK, clarification: { project } },
  { note: TASK, clarification: { status: 'someday', project } },
  { note: TASK, clarification: { status: 'inbox' } },
  { note: TASK, clarification: { contexts: [] } },
  { note: PLAIN, clarification: { asTask: true } },
  { note: PLAIN, clarification: { project } },
];
const FAULTS: readonly Fault[] = [
  'none',
  'move refused',
  'text write refused',
  'stamp refused',
  'name taken',
  'project gone meanwhile',
  'edited after write',
];

/** Every request against every fault, in a seeded order. */
function seededRuns(seed: number) {
  const random = seeded(seed);
  const runs = REQUESTS.flatMap((request) => FAULTS.map((fault) => ({ ...request, fault })));
  for (let at = runs.length - 1; at > 0; at -= 1) {
    const other = Math.floor(random() * (at + 1));
    [runs[at], runs[other]] = [runs[other]!, runs[at]!];
  }
  return runs;
}

const SEED = 612;
const label = (run: { note: string; clarification: Clarification; fault: Fault }) =>
  `${run.note === TASK ? 'task' : 'plain note'} ${JSON.stringify(run.clarification)} / ${run.fault}`;

describe('clarifyInboxItem — seeded requests and faults (#225, PR #612)', () => {
  it('changes nothing when it rejects: a rejection is offered no undo', async () => {
    const broken: string[] = [];
    for (const run of seededRuns(SEED)) {
      const v = vault(run.note, run.fault);
      const before = v.snapshot();
      const rejected = await v.clarify(run.clarification).then(
        () => false,
        () => true,
      );
      if (rejected && !sameFiles(before, v.files)) broken.push(label(run));
    }
    expect(broken).toEqual([]);
  });

  it('says it clarified anything exactly when the vault differs from before', async () => {
    const broken: string[] = [];
    for (const run of seededRuns(SEED)) {
      const v = vault(run.note, run.fault);
      const before = v.snapshot();
      const outcome = await v.clarify(run.clarification).catch(() => null);
      if (outcome === null) continue;
      if (clarifiedAnything(outcome) !== !sameFiles(before, v.files)) broken.push(label(run));
    }
    expect(broken).toEqual([]);
  });

  it('undoes exactly what changed: every note is as it was', async () => {
    const broken: string[] = [];
    for (const run of seededRuns(SEED)) {
      if (run.fault === 'edited after write') continue; // An edit since is kept: its own test.
      const v = vault(run.note, run.fault);
      const before = v.snapshot();
      const outcome = await v.clarify(run.clarification).catch(() => null);
      if (outcome === null || !clarifiedAnything(outcome)) continue;
      // An undo that fails is offered again (#455): tried twice, as the toast lets it be.
      const tryUndo = () =>
        v.undo(outcome).then(
          () => true,
          () => false,
        );
      const undone = (await tryUndo()) || (await tryUndo());
      if (!undone || !sameFiles(before, v.files)) broken.push(label(run));
    }
    expect(broken).toEqual([]);
  });
});

describe('undoClarifyInboxItem — an edit saved after the clarification wrote (#225, PR #612)', () => {
  it('keeps what another editor typed after the clarification’s write', async () => {
    const v = vault(TASK, 'edited after write');
    const outcome = await v.clarify({ status: 'next-action' });

    await v.undo(outcome).catch(() => {
      // Refusing is one right answer: the edit is then kept, as asserted below.
    });

    expect(v.files.get(CALL)).toContain('Typed on the other Mac.');
  });
});

/** The vault's notes compared, but for the project, which sync may take away by itself. */
function sameFiles(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>) {
  const notes = (files: ReadonlyMap<string, string>) =>
    [...files].filter(([at]) => at !== PROJECT).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(notes(before)) === JSON.stringify(notes(after));
}

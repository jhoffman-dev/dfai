// @vitest-environment jsdom
/**
 * Attack on PR #627 (#175): the gates as a state machine, driven by seeded
 * runs of pulls, sleeps, pauses and naming, against the hook as the window
 * runs it. Each step is checked against what the gates hold then.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  createVaultPath,
  type MeetingsWaiting,
  type PullStanding,
  type WaitingCountGate,
} from '@dfai/domain';
import {
  createNoteChanges,
  fakeIndexPort,
  fakeVaultFs,
  recordingActivity,
  type MeetingImportPorts,
} from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import type { PulledFilesGate } from '../sync/use-pulled-files.ts';
import { useMeetingImport } from './use-meeting-import.ts';

const VAULT = '/Users/j/Vault';
const MEETING = 'Inbox/Meetings/2026-10-06 Standup.md';
const MEETING_TEXT = [
  '---',
  'type: meeting',
  'atlas_import: meeting/v1',
  "title: 'Standup'",
  '---',
  '',
  'Notes.',
  '',
].join('\n');

const folder = (path: string, name: string) => ({
  kind: 'directory' as const,
  name,
  path: createVaultPath(path),
});

/** One unstamped meeting, modified at 1; every read of it is counted. */
function portsOver(reads: string[]): MeetingImportPorts {
  return {
    fs: fakeVaultFs({
      listDirectory: async (path) =>
        path === ''
          ? [folder('Inbox', 'Inbox')]
          : path === 'Inbox'
            ? [folder('Inbox/Meetings', 'Meetings')]
            : [{ kind: 'file', name: '2026-10-06 Standup.md', path: createVaultPath(MEETING) }],
      readTextFile: async (path) => {
        reads.push(path);
        return { text: MEETING_TEXT, modified: 1 };
      },
    }),
    index: fakeIndexPort(),
    markdown: remarkMarkdown,
    editors: {
      state: () => 'closed',
      flush: async () => undefined,
      follow: () => undefined,
      abandon: () => undefined,
      reload: () => undefined,
    },
  };
}

/** A pull that completed after the meeting was modified: a new one each time, as each pull leaves. */
const pulled = (): Extract<PullStanding, { kind: 'pulled' }> => ({
  kind: 'pulled',
  startedAsleepMs: 0,
  finishedAt: 10,
  namedAfter: false,
});

/**
 * The gates as they stand at a pull, as the real gate judges a count: shut
 * while sync is paused, during a pull, and once the Mac has slept since the
 * pull started — though the standing is still that pull's.
 */
const gateAt = (
  standing: PullStanding | null,
  { slept = false, paused = false } = {},
): PulledFilesGate => ({
  standing,
  slept,
  paused,
  acts: async () => false,
  countGate: async (): Promise<WaitingCountGate> => {
    if (paused) return { open: false, why: 'paused' };
    if (standing?.kind === 'pulling') return { open: false, why: 'pulling' };
    return standing?.kind === 'pulled' && !slept
      ? { open: true, standing }
      : { open: false, why: 'no-pull' };
  },
});

/** The index hearing of the meeting file changing, as a pull or a save makes it. */
const meetingNews = {
  vault: VAULT,
  changes: [{ kind: 'changed' as const, path: MEETING, type: 'meeting', digest: 'x' }],
};

interface Props {
  pulledFiles: PulledFilesGate;
  namedElsewhere: { readonly name: string | null } | null;
  active: boolean;
}

function render(initial: Props) {
  const reads: string[] = [];
  const ports = portsOver(reads);
  const changes = createNoteChanges({ onError: () => undefined });
  const activity = recordingActivity();
  const onWaiting = vi.fn<(vault: string, waiting: MeetingsWaiting | null) => void>();
  const clock = { today: () => '2026-10-08' };
  const hook = renderHook(
    ({ pulledFiles, namedElsewhere, active }: Props) =>
      useMeetingImport({
        changes,
        ports,
        clock,
        activity,
        vaultKey: VAULT,
        selfName: null,
        selfEmails: [],
        ownerKnown: true,
        active,
        indexReady: true,
        pulledFiles,
        namedElsewhere,
        onWaiting,
        onWritten: () => undefined,
      }),
    { initialProps: initial },
  );
  const warnings = () =>
    activity.reports.filter((report) => report.level === 'warning').map((report) => report.message);
  const lastSaid = () => onWaiting.mock.calls.at(-1)?.[1];
  return { ...hook, reads, changes, warnings, lastSaid, onWaiting };
}

async function settled(): Promise<void> {
  await act(async () => {
    for (let turn = 0; turn < 40; turn += 1) await Promise.resolve();
  });
}

const STUDIO = { name: 'Studio' };

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

type Step =
  | 'pull-starts'
  | 'pull-completes'
  | 'pull-fails'
  | 'sleeps'
  | 'pauses'
  | 'resumes'
  | 'named-here'
  | 'named-elsewhere'
  | 'settings-unreadable'
  | 'meeting-news'
  | 'other-news';

const STEPS: readonly Step[] = [
  'pull-starts',
  'pull-completes',
  'pull-fails',
  'sleeps',
  'pauses',
  'resumes',
  'named-here',
  'named-elsewhere',
  'settings-unreadable',
  'meeting-news',
  'other-news',
];

/** What the gates and the settings hold, as the model knows them. */
interface Model {
  standing: PullStanding | null;
  slept: boolean;
  paused: boolean;
  who: 'elsewhere' | 'here' | 'unreadable';
}

const propsOf = (model: Model): Props => ({
  pulledFiles: gateAt(model.standing, { slept: model.slept, paused: model.paused }),
  namedElsewhere: model.who === 'elsewhere' ? { name: 'Studio' } : null,
  active: model.who === 'here',
});

const gatesHold = (model: Model) =>
  model.who === 'elsewhere' && model.standing?.kind === 'pulled' && !model.slept && !model.paused;

function next(model: Model, step: Step): Model {
  switch (step) {
    case 'pull-starts':
      return model.standing?.kind === 'pulling'
        ? model
        : { ...model, standing: { kind: 'pulling' } };
    case 'pull-completes':
      return model.standing?.kind === 'pulling'
        ? { ...model, standing: pulled(), slept: false }
        : model;
    case 'pull-fails':
      // A failed pull leaves nothing known: no completed pull to count against.
      return model.standing?.kind === 'pulling' ? { ...model, standing: null } : model;
    case 'sleeps':
      return model.standing?.kind === 'pulled' ? { ...model, slept: true } : model;
    case 'pauses':
      return { ...model, paused: true };
    case 'resumes':
      return { ...model, paused: false };
    case 'named-here':
      return { ...model, who: 'here' };
    case 'named-elsewhere':
      return { ...model, who: 'elsewhere' };
    case 'settings-unreadable':
      return { ...model, who: 'unreadable' };
    case 'meeting-news':
    case 'other-news':
      return model;
  }
}

/** Pulls and news weighed up, so runs spend time with a number shown: what the invariants are about. */
const WEIGHTED: readonly Step[] = [
  ...STEPS,
  'pull-starts',
  'pull-completes',
  'pull-completes',
  'meeting-news',
  'meeting-news',
  'named-elsewhere',
  'resumes',
];
const RUNS = 150;
const STEPS_PER_RUN = 30;

describe('the waiting line as the gates move, over seeded runs (attack on PR #627)', () => {
  it('holds every invariant of the gates at every step', async () => {
    for (let seed = 1; seed <= RUNS; seed += 1) {
      const rng = seeded(seed);
      let model: Model = { standing: null, slept: false, paused: false, who: 'elsewhere' };
      const { rerender, reads, lastSaid, warnings, changes, unmount } = render(propsOf(model));
      await settled();
      const trail: Step[] = [];
      for (let at = 0; at < STEPS_PER_RUN; at += 1) {
        const step = WEIGHTED[Math.floor(rng() * WEIGHTED.length)]!;
        trail.push(step);
        const before = { model, said: lastSaid(), reads: reads.length };
        model = next(model, step);
        rerender(propsOf(model));
        if (step === 'meeting-news') changes.publish(meetingNews);
        if (step === 'other-news') {
          changes.publish({
            vault: VAULT,
            changes: [{ kind: 'changed', path: 'Projects/Plan.md', type: 'note', digest: 'y' }],
          });
        }
        await settled();
        const said = lastSaid();
        const where = { seed, trail: trail.join(' > ') };

        // A number only while both gates hold, on a Mac that is not named — or kept, as it was, while a pull runs.
        const kept =
          // A pause made mid-pull is its own test below.
          model.standing?.kind === 'pulling' && model.who === 'elsewhere';
        if (said?.kind === 'counted' && !kept)
          expect({ ...where, holds: gatesHold(model) }).toEqual({ ...where, holds: true });
        // Nothing is read on a Mac that is named here, or whose settings name none.
        if (model.who !== 'elsewhere')
          expect({ ...where, read: reads.length }).toEqual({ ...where, read: before.reads });
        // Mid-pull, with nothing else changed, a number shown stands as it was.
        const samePull =
          model.standing?.kind === 'pulling' &&
          !model.paused &&
          before.model.who === model.who &&
          before.said?.kind === 'counted';
        if (samePull) expect({ ...where, said }).toEqual({ ...where, said: before.said });
        // One meeting waits throughout: Activity warns of it once in the session at most.
        expect({ ...where, warnings: warnings().length <= 1 }).toEqual({
          ...where,
          warnings: true,
        });
      }
      unmount();
    }
  }, 120_000);
});

describe('the waiting line when sync is paused mid-pull (attack on PR #627)', () => {
  it('gives no number once sync is paused, though the pull has not ended', async () => {
    const props = { pulledFiles: gateAt(pulled()), namedElsewhere: STUDIO, active: false };
    const { rerender, lastSaid } = render(props);
    await settled();
    expect(lastSaid()).toEqual({ kind: 'counted', mac: 'Studio', count: 1 });
    const pulling: PullStanding = { kind: 'pulling' };
    rerender({ ...props, pulledFiles: gateAt(pulling) });
    await settled();

    // The person pauses sync while git is still fetching: the gates are shut (ADR-0035 part 4).
    rerender({ ...props, pulledFiles: gateAt(pulling, { paused: true }) });
    await settled();

    expect(lastSaid()).toEqual({ kind: 'uncounted', mac: 'Studio', why: 'paused' });
  });
});

// @vitest-environment jsdom
/**
 * #182: the window's meeting import counts imported meetings whose summary
 * and tasks are pending, and counts again when what the rules have finished
 * with changes; on the Mac that runs the automations it says when its own
 * step cannot reach Claude, and stops once it can.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  createVaultPath,
  type MeetingsWaiting,
  type PostProcessingLedger,
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
import { useMeetingImport, type PostProcessingNews } from './use-meeting-import.ts';

const VAULT = '/Users/j/Vault';
const MEETING = 'Inbox/Meetings/2026-10-06 Standup.md';
/** A meeting the import let in, with turns for the step to read, and no summary yet. */
const MEETING_TEXT = [
  '---',
  'type: meeting',
  'atlas_import: meeting/v1',
  'atlas_import_outcome: imported',
  'provider: gemini',
  'external_id: gemini-7f3a9c21',
  "date: '2026-10-06'",
  '---',
  '',
  '## Transcript',
  '',
  '**Mara Quill** [~00:00:00] Morning, Tobias. ^t0001',
  '',
].join('\n');
const NOT_LOGGED_IN = 'Claude Code is installed but not logged in. Fix: claude auth login';

const folder = (path: string, name: string) => ({
  kind: 'directory' as const,
  name,
  path: createVaultPath(path),
});

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

const PULLED: PullStanding = {
  kind: 'pulled',
  startedAsleepMs: 0,
  finishedAt: 10,
  namedAfter: false,
};
/** How often the import asked whether this Mac may act: each run, recount included, asks once. */
const asked = { acts: 0 };
const gate = (acts: boolean): PulledFilesGate => ({
  standing: PULLED,
  slept: false,
  paused: false,
  acts: async () => {
    asked.acts += 1;
    return acts;
  },
  countGate: async (): Promise<WaitingCountGate> => ({ open: true, standing: PULLED }),
});

const ledger = (answered: string[] = []): PostProcessingLedger => ({
  summarising: true,
  from: '2026-09-24',
  answered: new Set(answered),
  stored: new Set(),
});
const news = (answered: string[] = [], unavailable: string | null = null): PostProcessingNews => ({
  mark: answered.join(','),
  unavailable,
  mac: 'Studio',
  ledger: () => ledger(answered),
  take: async () => null,
});

interface Props {
  named: boolean;
  postProcessing: PostProcessingNews;
}

function render(initial: Props) {
  const reads: string[] = [];
  const ports = portsOver(reads);
  const changes = createNoteChanges({ onError: () => undefined });
  const activity = recordingActivity();
  const onWaiting = vi.fn<(vault: string, waiting: MeetingsWaiting | null) => void>();
  const clock = { today: () => '2026-10-08' };
  const hook = renderHook(
    ({ named, postProcessing }: Props) =>
      useMeetingImport({
        changes,
        ports,
        clock,
        activity,
        vaultKey: VAULT,
        selfName: null,
        selfEmails: [],
        ownerKnown: true,
        active: named,
        indexReady: true,
        pulledFiles: gate(named),
        namedElsewhere: named ? null : { name: 'Studio' },
        onWaiting,
        onWritten: () => undefined,
        postProcessing,
      }),
    { initialProps: initial },
  );
  const warnings = () =>
    activity.reports.filter((report) => report.level === 'warning').map((report) => report.message);
  const lastSaid = () => onWaiting.mock.calls.at(-1)?.[1];
  return { ...hook, reads, warnings, lastSaid, onWaiting };
}

async function settled(): Promise<void> {
  await act(async () => {
    for (let turn = 0; turn < 40; turn += 1) await Promise.resolve();
  });
}

describe('useMeetingImport and post-processing (#182)', () => {
  it('on a Mac that is not named, counts a meeting whose summary is pending, and drops it once it is answered', async () => {
    const { rerender, lastSaid, reads } = render({ named: false, postProcessing: news() });
    await settled();
    expect(lastSaid()).toEqual({ kind: 'counted', mac: 'Studio', count: 1 });
    const readsBefore = reads.length;

    rerender({ named: false, postProcessing: news([MEETING]) });
    await settled();

    expect(lastSaid()).toEqual({ kind: 'counted', mac: 'Studio', count: 0 });
    // What the file holds is already known: only the ledger moved.
    expect(reads).toHaveLength(readsBefore);
  });

  it('on the named Mac, says its step cannot reach Claude once, with the count, and nothing once it can', async () => {
    const { rerender, lastSaid, warnings } = render({ named: true, postProcessing: news() });
    await settled();
    expect(lastSaid() ?? null).toBeNull();

    rerender({ named: true, postProcessing: news([], NOT_LOGGED_IN) });
    await settled();
    expect(lastSaid()).toEqual({
      kind: 'failing',
      mac: 'Studio',
      count: 1,
      problem: NOT_LOGGED_IN,
    });

    rerender({ named: true, postProcessing: news(['x'], NOT_LOGGED_IN) });
    await settled();
    expect(warnings()).toEqual([
      `Claude is unavailable on Studio: summaries and tasks are pending. ${NOT_LOGGED_IN}`,
    ]);

    rerender({ named: true, postProcessing: news([MEETING]) });
    await settled();
    expect(lastSaid()).toBeNull();
  });

  it('on a healthy named Mac, reads nothing more when the rules’ ledger moves', async () => {
    const { rerender, reads } = render({ named: true, postProcessing: news() });
    await settled();
    const readsBefore = reads.length;
    const actsBefore = asked.acts;

    rerender({ named: true, postProcessing: news([MEETING]) });
    await settled();

    expect(reads).toHaveLength(readsBefore);
    // No run was made for it at all: a healthy Mac that imports has no line to say.
    expect(asked.acts).toBe(actsBefore);
  });
});

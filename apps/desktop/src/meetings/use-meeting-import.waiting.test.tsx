// @vitest-environment jsdom
/**
 * #175 (ADR-0035 parts 1 and 3): on a Mac that is not named, the window's
 * meeting import counts what waits for the named Mac once per pull, says it
 * for the Inbox, and warns in Activity — instead of dropping it silently.
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

describe('useMeetingImport on a Mac that is not named (#175)', () => {
  it('before a pull, says meetings may wait and gives no count, reading no meeting', async () => {
    const { reads, lastSaid, warnings } = render({
      pulledFiles: gateAt(null),
      namedElsewhere: STUDIO,
      active: false,
    });
    await settled();

    expect(lastSaid()).toEqual({ kind: 'uncounted', mac: 'Studio', why: 'no-pull' });
    expect(reads).toEqual([]);
    expect(warnings()).toEqual([]);
  });

  it('once a pull completes, counts and warns once; the change feed’s news for that pull repeats nothing', async () => {
    const props = { pulledFiles: gateAt(null), namedElsewhere: STUDIO, active: false };
    const { rerender, reads, lastSaid, warnings, changes } = render(props);
    await settled();

    rerender({ ...props, pulledFiles: gateAt(pulled()) });
    await settled();
    expect(lastSaid()).toEqual({ kind: 'counted', mac: 'Studio', count: 1 });
    expect(warnings()).toEqual(['1 meeting is waiting for Studio to process it.']);
    const readsAfter = reads.length;

    // The same pull's news, as the index hears what it brought: nothing new is read or said.
    changes.publish({ vault: VAULT, changes: [] });
    await settled();
    expect(warnings()).toHaveLength(1);
    expect(reads).toHaveLength(readsAfter);
  });

  it('keeps the count while a pull is under way, though the pull’s news arrives, and warns of nothing new after it', async () => {
    const props = { pulledFiles: gateAt(pulled()), namedElsewhere: STUDIO, active: false };
    const { rerender, warnings, lastSaid, changes } = render(props);
    await settled();
    expect(warnings()).toHaveLength(1);

    rerender({ ...props, pulledFiles: gateAt({ kind: 'pulling' }) });
    await settled();
    changes.publish(meetingNews);
    await settled();
    expect(lastSaid()).toEqual({ kind: 'counted', mac: 'Studio', count: 1 });

    // The pull completes with the same count: said again, not warned again.
    rerender({ ...props, pulledFiles: gateAt(pulled()) });
    await settled();
    expect(lastSaid()).toEqual({ kind: 'counted', mac: 'Studio', count: 1 });
    expect(warnings()).toHaveLength(1);
  });

  it('after a wake, with the standing still the last pull’s, gives no number until a pull completes (#627 review)', async () => {
    const standing = pulled();
    const props = { pulledFiles: gateAt(standing), namedElsewhere: STUDIO, active: false };
    const { rerender, lastSaid } = render(props);
    await settled();
    expect(lastSaid()).toMatchObject({ kind: 'counted' });

    rerender({ ...props, pulledFiles: gateAt(standing, { slept: true }) });
    await settled();

    expect(lastSaid()).toEqual({ kind: 'uncounted', mac: 'Studio', why: 'no-pull' });
  });

  it('once sync is paused, with the standing still the last pull’s, gives no number until it resumes', async () => {
    const standing = pulled();
    const props = { pulledFiles: gateAt(standing), namedElsewhere: STUDIO, active: false };
    const { rerender, lastSaid } = render(props);
    await settled();

    rerender({ ...props, pulledFiles: gateAt(standing, { paused: true }) });
    await settled();
    expect(lastSaid()).toEqual({ kind: 'uncounted', mac: 'Studio', why: 'paused' });

    rerender({ ...props, pulledFiles: gateAt(standing) });
    await settled();
    expect(lastSaid()).toEqual({ kind: 'counted', mac: 'Studio', count: 1 });
  });

  it('on the named Mac, with its gates shut, a run says nothing waits and reads nothing to count', async () => {
    const { reads, warnings, onWaiting, changes } = render({
      pulledFiles: gateAt(pulled()),
      namedElsewhere: null,
      active: true,
    });
    await settled();

    changes.publish(meetingNews);
    await settled();

    // A run was made, and it said nothing waits.
    expect(onWaiting).toHaveBeenCalledWith(VAULT, null);
    expect(reads).toEqual([]);
    expect(warnings()).toEqual([]);
  });

  it('clears what it said once this Mac is named', async () => {
    const props = { pulledFiles: gateAt(pulled()), namedElsewhere: STUDIO, active: false };
    const { rerender, lastSaid } = render(props);
    await settled();
    expect(lastSaid()).toMatchObject({ kind: 'counted' });

    rerender({ ...props, namedElsewhere: null, active: true });
    await settled();
    expect(lastSaid()).toBeNull();
  });
});

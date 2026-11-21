// @vitest-environment jsdom
/**
 * The meeting import under the Meetings switch (#901): off, this Mac imports
 * nothing and says nothing waits for another, as a Mac that does not run the
 * automations; on again, it catches up, as when this Mac takes them over. The
 * claim itself is sync's and is left as it is.
 */
import { describe, expect, it } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import { createVaultPath, digestOf, type NoteChange } from '@dfai/domain';
import {
  createNoteChanges,
  fakeIndexPort,
  fakeVaultFs,
  recordingActivity,
  type MeetingImportPorts,
  type RuleQueryPorts,
  workSwitch,
} from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { createAutomationsStore } from '../automations/automations-store.ts';
import { createSyncStore, publishSync, type SyncStore } from '../sync/sync-store.ts';
import type { SyncController } from '../sync/use-sync.ts';
import { MeetingImportRunner } from './meeting-import-runner.tsx';
import { createMeetingsWaitingStore, sayMeetingsWaiting } from './meetings-waiting-store.ts';

const VAULT = '/Users/mara/Vault';
const MEETING = 'Inbox/Meetings/2026-10-06 Standup.md';
const MEETING_TEXT = '---\ntype: meeting\natlas_import: meeting/v1\n---\n\nNotes.\n';
const ARRIVED: NoteChange = {
  kind: 'added',
  path: MEETING,
  type: 'meeting',
  digest: digestOf(MEETING_TEXT),
};

const folder = (path: string, name: string) => ({
  kind: 'directory' as const,
  name,
  path: createVaultPath(path),
});

/** One meeting file to import, each write of it remembered. */
const portsOver = (written: string[]): MeetingImportPorts => ({
  fs: fakeVaultFs({
    listDirectory: async (path) =>
      path === ''
        ? [folder('Inbox', 'Inbox')]
        : path === 'Inbox'
          ? [folder('Inbox/Meetings', 'Meetings')]
          : [{ kind: 'file', name: '2026-10-06 Standup.md', path: createVaultPath(MEETING) }],
    readTextFile: async () => ({ text: MEETING_TEXT, modified: 1 }),
    writeTextFile: async ({ path }) => {
      written.push(path);
      return 2;
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
});

/** Sync as the Mac named for the vault's automations sees it, with every gate open. */
function namedHere(): SyncStore {
  const sync = createSyncStore();
  // Only what the runners read of sync: the test needs no more of the controller.
  publishSync(sync, VAULT, {
    phase: { kind: 'unknown' },
    thisMac: 'Studio',
    settings: {},
    automationsHere: true,
    syncedThisSession: new Set(),
    syncPulls: new Map(),
    pulledFiles: {
      standing: { kind: 'not-synced' },
      acts: async () => true,
      countGate: async () => ({ open: false, why: 'not-synced' }),
      slept: false,
      paused: false,
    },
  } as unknown as SyncController);
  return sync;
}

function mount(enabled: boolean) {
  const written: string[] = [];
  const changes = createNoteChanges({ onError: () => undefined });
  const waiting = createMeetingsWaitingStore();
  const props = {
    sync: namedHere(),
    automations: createAutomationsStore(),
    // No rule takes a meeting here: the import asks the rules nothing in these tests.
    rulePorts: () => ({}) as unknown as RuleQueryPorts,
    waiting,
    changes,
    ports: portsOver(written),
    clock: {
      today: () => '2026-10-08',
      localNow: () => '2026-10-08T09:00:00',
      now: () => Date.parse('2026-10-08T09:00:00Z'),
    },
    activity: recordingActivity(),
    vaultKey: VAULT,
    indexReady: true,
    selfName: null,
    selfEmails: [],
    ownerKnown: true,
    onWritten: () => undefined,
  } as const;
  // The index is seen building, then ready, as a vault opening has it.
  const view = render(
    <MeetingImportRunner {...props} indexReady={false} enabled={workSwitch(enabled)} />,
  );
  view.rerender(<MeetingImportRunner {...props} enabled={workSwitch(enabled)} />);
  const switchTo = (on: boolean) =>
    view.rerender(<MeetingImportRunner {...props} enabled={workSwitch(on)} />);
  return { written, changes, waiting, switchTo };
}

const settled = () =>
  act(async () => {
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
  });

describe('MeetingImportRunner and the Meetings switch (#901)', () => {
  it('imports nothing with Meetings off, on the Mac named for the automations', async () => {
    const { written, changes } = mount(false);
    await settled();
    changes.publish({ vault: VAULT, changes: [ARRIVED] });
    await settled();
    expect(written).toEqual([]);
  });

  it('catches up once Meetings is switched on, and imports nothing more once it is off', async () => {
    const { written, changes, switchTo } = mount(false);
    await settled();
    switchTo(true);
    await waitFor(() => expect(written).toEqual([MEETING]));

    switchTo(false);
    await settled();
    changes.publish({ vault: VAULT, changes: [ARRIVED] });
    await settled();
    expect(written).toEqual([MEETING]);
  });

  it('says nothing waits for another Mac once Meetings is off', async () => {
    const { waiting, switchTo } = mount(true);
    sayMeetingsWaiting(waiting, VAULT, { kind: 'counted', mac: 'Laptop', count: 2 });
    switchTo(false);
    await settled();
    expect(waiting.getState()).toMatchObject({ vault: VAULT, waiting: null });
  });
});

// @vitest-environment jsdom
/**
 * The relay as the app feeds it (`app.tsx`): each render's vault, runner
 * start and pauses, pointed in an effect. Attacked across a vault switch: the
 * API must never be told another vault's pauses as this vault's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useEffect } from 'react';
import { createVaultPath, type VaultEntry, type VaultPath } from '@dfai/domain';
import {
  fakeClaudeStepPorts,
  fakeIndexPort,
  fakeVaultFs,
  type AutomationPorts,
  recordingActivity,
} from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import { useAutomations, type AutomationsOptions } from '../automations/use-automations.ts';
import { createAutomationRelay, type WatchedVault } from './automation-relay.ts';

const HOME = '/vaults/home';
const WORK = '/vaults/work';

const RULE = [
  '---',
  'atlas: automation',
  'id: Sweep',
  'name: Sweep',
  'enabled: true',
  'when: every 1 hour',
  'which: FROM task',
  'do: archive',
  '---',
  '',
].join('\n');
const DUE_LOG = [
  '---\natlas: automation-log\n---\n\n# Sweep — run log\n',
  '## 2026-09-27 08:00:00 · Turned on\n\nIt runs on its schedule from here on.\n',
].join('\n');

/** A vault with one due rule whose log the disk refuses: the runner pauses it. */
function refusingVault(): AutomationPorts & { notePaths: readonly VaultPath[] } {
  const files: Record<string, string> = {
    '.atlas/automations/Sweep.md': RULE,
    '.atlas/automations/log/Sweep.md': DUE_LOG,
    'Tasks/A.md': '---\ntype: task\n---\n',
  };
  const refuse = async (): Promise<never> => {
    throw new Error('The disk is full.');
  };
  const parent = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')));
  const fs = fakeVaultFs({
    listNotes: async () =>
      Object.keys(files).map((path) => ({
        name: path.slice(path.lastIndexOf('/') + 1),
        path: createVaultPath(path),
        modified: 1,
        size: 1,
      })),
    listDirectory: async (at) =>
      Object.keys(files)
        .filter((file) => parent(file) === at)
        .map(
          (file) =>
            ({
              kind: 'file',
              name: file.slice(file.lastIndexOf('/') + 1),
              path: createVaultPath(file),
            }) as VaultEntry,
        ),
    readNotes: async (paths) =>
      paths.flatMap((path) => {
        const text = files[path];
        return text === undefined ? [] : [{ path, text, modified: 1, size: text.length }];
      }),
    readTextFile: async (path) => ({ text: files[path] ?? '', modified: 1 }),
    createFolder: refuse,
    createNote: refuse,
    writeTextFile: refuse,
    moveEntry: refuse,
  });
  return {
    fs,
    markdown: remarkMarkdown,
    index: fakeIndexPort({
      query: async () => ({ columns: ['path', 'title', 'type'], rows: [], truncated: false }),
    }),
    editors: {
      state: () => 'closed',
      flush: async () => {},
      follow: () => {},
      abandon: () => {},
      reload: () => {},
    },
    types: [{ name: 'task', label: 'Task', properties: [] } as never],
    notePaths: Object.keys(files).map(createVaultPath),
    claude: fakeClaudeStepPorts(),
  };
}

const clock = {
  today: () => '2026-09-27',
  localNow: () => '2026-09-27T09:00:00',
  now: () => Date.parse('2026-09-27T09:00:00Z'),
};

async function settle() {
  for (let round = 0; round < 8; round += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  }
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the automation relay across a vault switch', () => {
  it("never answers for the vault now open with the last vault's pauses", async () => {
    const relay = createAutomationRelay();
    const told: WatchedVault[] = [];
    const initial: AutomationsOptions = {
      ports: refusingVault(),
      clock,
      vaultKey: HOME,
      indexKey: '1',
      indexReady: true,
      activity: recordingActivity(),
      onSettled: () => {},
    };
    const hook = renderHook(
      (props: AutomationsOptions) => {
        const automations = useAutomations(props);
        const { watchingSince, pauses } = automations;
        // As app.tsx points it.
        useEffect(() => {
          const watched = { vault: props.vaultKey, watchingSince, pauses };
          told.push(watched);
          relay.point(watched);
        }, [props.vaultKey, watchingSince, pauses]);
        return automations;
      },
      { initialProps: initial },
    );
    await settle();
    // The home vault's rule could not log its run, so the runner paused it.
    expect(hook.result.current.pauses.has('Sweep')).toBe(true);

    hook.rerender({ ...initial, vaultKey: WORK, indexKey: '2' });

    // A rule called Sweep in the work vault has never failed; it is not paused there.
    const toldForWork = told.filter((watched) => watched.vault === WORK);
    expect(toldForWork.length).toBeGreaterThan(0);
    expect(toldForWork.map((watched) => [...watched.pauses.keys()])).toEqual(
      toldForWork.map(() => []),
    );
  });
});

// @vitest-environment jsdom
/**
 * #130: each of the Inbox's five offers says `reading` while the Inbox is open
 * and this vault's first preview is not back, so the page can hold its rows
 * that long and no longer. The first preview runs as soon as the index is
 * ready, Inbox open or not, so opening it usually waits for nothing.
 *
 * Every read the hooks make goes through a gate the test opens, or fails.
 */
import { describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import {
  fakeIndexPort,
  fakeVaultFs,
  recordingActivity,
  type ActivityRecorder,
  type ArchivePorts,
} from '@dfai/application';
import { remarkMarkdown } from '@dfai/adapters';
import type { InboxOfferReading } from '@dfai/ui';
import { useTaskMigration } from './gtd/use-task-migration.ts';
import { useMeetingCleanup } from './meetings/use-meeting-cleanup.ts';
import { useMeetingProjects } from './meetings/use-meeting-projects.ts';
import { useParaMigration } from './para/use-para-migration.ts';
import { useVaultTidy } from './vault/use-vault-tidy.ts';

const OWNER = { selfName: 'Mara Quill', selfEmails: [] };

interface Shown {
  readonly open: boolean;
  readonly vaultKey: string | null;
  readonly indexReady: boolean;
  readonly owner?: typeof OWNER | null;
}

interface Wiring {
  readonly ports: ArchivePorts;
  readonly activity: ActivityRecorder;
}

type OfferHook = (wiring: Wiring, shown: Shown) => InboxOfferReading | null;

const HOOKS: Record<string, OfferHook> = {
  useTaskMigration: ({ ports, activity }, shown) =>
    useTaskMigration({ ports, activity, onChanged: () => {}, ...shown }),
  useParaMigration: ({ ports, activity }, shown) =>
    useParaMigration({ ports, activity, onChanged: () => {}, ...shown }),
  useVaultTidy: ({ ports, activity }, shown) =>
    useVaultTidy({ ports, activity, onChanged: () => {}, ...shown }),
  useMeetingCleanup: ({ ports, activity }, { owner = OWNER, ...shown }) =>
    useMeetingCleanup({
      ports,
      activity,
      owner,
      onChanged: () => {},
      onOpenTask: () => {},
      ...shown,
    }),
  useMeetingProjects: ({ ports, activity }, { open, vaultKey, indexReady }) =>
    useMeetingProjects({
      ports,
      activity,
      owner: OWNER,
      onChanged: () => {},
      open,
      vaultKey,
      indexReady,
    }),
};

/** Ports over an empty vault whose every read waits for `open()`, or fails after `fail()`. */
function gatedPorts() {
  let open: () => void = () => {};
  let fail: (cause: Error) => void = () => {};
  const gate = new Promise<void>((resolve, reject) => {
    open = resolve;
    fail = reject;
  });
  // A gate failed before anything waits on it is not an unhandled rejection: each read awaits it.
  gate.catch(() => {});
  let reads = 0;
  const gated = <Port extends object>(port: Port): Port =>
    new Proxy(port, {
      get(target, name, receiver) {
        const value: unknown = Reflect.get(target, name, receiver);
        if (typeof value !== 'function') return value;
        return async (...args: unknown[]) => {
          reads += 1;
          await gate;
          return (value as (...given: unknown[]) => unknown).apply(target, args);
        };
      },
    });
  const ports = {
    fs: gated(fakeVaultFs()),
    // One note filed already, as the index lists it: nothing for the tidy to move.
    index: gated(
      fakeIndexPort({
        manifest: async () => [
          { path: 'Notes/2026/Kept.md', modified: 0, size: 0, type: null, digest: '' },
        ],
      }),
    ),
    markdown: remarkMarkdown,
    editors: {
      state: () => 'closed',
      flush: async () => undefined,
      follow: () => undefined,
      abandon: () => undefined,
      reload: () => undefined,
    },
  } as unknown as ArchivePorts;
  return {
    ports,
    open: () => open(),
    fail: () => fail(new Error('disk gone')),
    reads: () => reads,
  };
}

function mount(hook: OfferHook, shown: Shown) {
  const gate = gatedPorts();
  const wiring = { ports: gate.ports, activity: recordingActivity() };
  const view = renderHook((props: Shown) => hook(wiring, props), { initialProps: shown });
  return { ...gate, view };
}

const SHOWN: Shown = { open: true, vaultKey: '/vaults/home', indexReady: true };
const reading = (offer: InboxOfferReading | null) => offer?.reading === true;

describe.each(Object.entries(HOOKS))('%s says when it is still reading (#130)', (_, hook) => {
  it('reads while the Inbox is open and the preview is out, and stops once it is back', async () => {
    const { view, open } = mount(hook, SHOWN);
    expect(reading(view.result.current)).toBe(true);
    await act(async () => open());
    await waitFor(() => expect(reading(view.result.current)).toBe(false));
  });

  it('stops reading when the preview fails, so the rows are not held for it', async () => {
    const { view, fail } = mount(hook, SHOWN);
    expect(reading(view.result.current)).toBe(true);
    await act(async () => fail());
    await waitFor(() => expect(reading(view.result.current)).toBe(false));
  });

  // The last fix round (#130, bug 4): a vault just opened has no index yet, and its
  // offers are not known until it does, so its rows are held for them.
  it('waits for the index, reading nothing, while saying it is still reading', async () => {
    const { view, reads } = mount(hook, { ...SHOWN, indexReady: false });
    await act(async () => {});
    expect(reading(view.result.current)).toBe(true);
    expect(view.result.current?.waitingForIndex).toBe(true);
    expect(reads()).toBe(0);
    view.rerender(SHOWN);
    expect(view.result.current?.waitingForIndex).toBe(false);
    expect(reading(view.result.current)).toBe(true);
  });

  it('reads again from the start when another vault opens', async () => {
    const { view, open } = mount(hook, SHOWN);
    await act(async () => open());
    await waitFor(() => expect(reading(view.result.current)).toBe(false));
    view.rerender({ ...SHOWN, vaultKey: '/vaults/work' });
    expect(reading(view.result.current)).toBe(true);
  });
});

describe.each(Object.entries(HOOKS))('%s is read ahead of the Inbox (#130)', (_, hook) => {
  it('reads as soon as the index is ready, with the Inbox shut, so opening it waits for nothing', async () => {
    const { view, open, reads } = mount(hook, { ...SHOWN, open: false });
    await waitFor(() => expect(reads()).toBeGreaterThan(0));
    await act(async () => open());
    await act(async () => {});
    view.rerender(SHOWN);
    expect(reading(view.result.current)).toBe(false);
  });
});

describe('useMeetingCleanup while the owner is not known (#130)', () => {
  it('is not reading: nothing is read for it until the owner is', async () => {
    const { view, reads } = mount(HOOKS['useMeetingCleanup']!, { ...SHOWN, owner: null });
    await act(async () => {});
    expect(reading(view.result.current)).toBe(false);
    expect(reads()).toBe(0);
  });
});

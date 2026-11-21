// @vitest-environment jsdom
/**
 * The Automations tab with the feature off (#901, #920): each rule whose last
 * run can be undone, and what an undo did or why it could not, said where a
 * screen reader hears it. The runner's state is handed in through its store,
 * as `AutomationsRunner` publishes it.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLayoutEffect, useState } from 'react';
import type { AutomationListing } from '@dfai/application';
import type { LogEntry } from '@dfai/domain';
import type { PageContainerProps } from '../workspace/page-wiring.ts';
import { AutomationsOffPage } from './automations-off-page.tsx';
import {
  createAutomationsStore,
  publishAutomations,
  type AutomationsController,
} from './automations-store.ts';

const RAN: LogEntry = {
  kind: 'run',
  at: '2026-11-18T09:00:00',
  trigger: 'open',
  done: [{ kind: 'archived', from: 'Tasks/A.md', to: 'Archive/Tasks/A.md' }],
  left: [],
  capped: false,
} as unknown as LogEntry;

const UNDONE: LogEntry = {
  kind: 'undo',
  at: '2026-11-18T09:05:00',
  of: '2026-11-18T09:00:00',
  done: [{ kind: 'restored', from: 'Archive/Tasks/A.md', to: 'Tasks/A.md' }],
  left: [],
} as unknown as LogEntry;

const SWEEP = { id: 'Sweep', path: '.atlas/automations/Sweep.md', name: 'Sweep' };

/**
 * The runner's controller as the page reads it: only what the off page uses
 * is real. `undo` answers as the one door does: the undo's entry, or null
 * having said why in `notice`.
 */
function Runner({
  store,
  undo,
}: {
  store: ReturnType<typeof createAutomationsStore>;
  undo: (said: (notice: string) => void) => Promise<LogEntry | null>;
}) {
  const [notice, setNotice] = useState<string | null>(null);
  const [log, setLog] = useState<readonly LogEntry[]>([RAN]);
  const listing = {
    automations: [{ rule: SWEEP, log }],
    broken: [],
  } as unknown as AutomationListing;
  // Only the fields the off page reads: the rest of the controller is the page's, not this tab's.
  const controller = {
    listing,
    busy: false,
    notice,
    setNotice,
    undo: async () => {
      const entry = await undo((said) => setNotice(said));
      if (entry !== null) setLog([RAN, entry]);
      return entry;
    },
  } as unknown as AutomationsController;
  // As the runner publishes, before paint.
  useLayoutEffect(() => publishAutomations(store, controller));
  return null;
}

function mount(undo: (said: (notice: string) => void) => Promise<LogEntry | null>) {
  const store = createAutomationsStore();
  const wiring = { pages: { automations: { store } } } as unknown as PageContainerProps['wiring'];
  render(
    <>
      <Runner store={store} undo={undo} />
      <AutomationsOffPage wiring={wiring} chrome={{}} onTurnOn={vi.fn()} />
    </>,
  );
}

describe('AutomationsOffPage (#920)', () => {
  it('says why an undo was refused', async () => {
    mount(async (said) => {
      said('It is no longer where the run put it, so it was left where it is.');
      return null;
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Undo last run of Sweep' }));
    const why = await screen.findByText(
      'It is no longer where the run put it, so it was left where it is.',
    );
    expect(why.getAttribute('role')).toBe('status');
  });

  it('announces an undo that went through, and keeps focus off the page', async () => {
    mount(async () => UNDONE);
    await userEvent.click(await screen.findByRole('button', { name: 'Undo last run of Sweep' }));
    const said = await screen.findByText(/^Undid the last run of Sweep\./);
    expect(said.getAttribute('role')).toBe('status');
    expect(screen.queryByRole('button', { name: 'Undo last run of Sweep' })).toBeNull();
    expect(document.activeElement).toBe(said);
  });
});

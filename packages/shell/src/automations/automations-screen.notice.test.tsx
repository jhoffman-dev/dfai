// @vitest-environment jsdom
/**
 * The read-twice offer's "Turn off" (#793): what its click could not do is
 * said where the page says what a command did, and gives way to what is said
 * after it. Over a runner faked as its notice and its switch.
 */
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { AFTER_A_MEETING_PRESET, AUTOMATION_PRESETS, type AutomationRule } from '@dfai/domain';
import { fakeIndexPort, recordingActivity } from '@dfai/application';
import { queryWrapper } from '../reads/query-wrapper.tsx';
import type { AutomationsController } from './automations-store.ts';
import { AutomationsScreen } from './automations-screen.tsx';

const TODAY = '2026-10-14';
const CLOCK = {
  today: () => TODAY,
  localNow: () => `${TODAY}T09:00:00`,
  now: () => Date.parse(`${TODAY}T09:00:00Z`),
};
const DECLARED = {
  ...AFTER_A_MEETING_PRESET,
  id: 'after',
  path: '.atlas/automations/After a meeting.md',
} as AutomationRule;
const EXTRACTION = {
  ...AUTOMATION_PRESETS.find(
    (preset) => preset.name === 'Pull actions and decisions out of a new meeting',
  )!,
  id: 'pull',
  path: '.atlas/automations/Pull actions.md',
} as AutomationRule;
const LISTING = {
  automations: [DECLARED, EXTRACTION].map((rule) => ({ rule, log: [], ledger: null })),
  broken: [],
};
const PORTS = { index: fakeIndexPort([]), types: [], notePaths: [] } as unknown as Parameters<
  typeof AutomationsScreen
>[0]['ports'];

/** What the switch does when asked: says something, or nothing, and answers. */
type Switch = (say: (notice: string) => void) => Promise<null>;

function renderScreen(flip: Switch) {
  const said: { say: (notice: string | null) => void } = { say: () => {} };
  function Runner() {
    const [notice, setNotice] = useState<string | null>(null);
    said.say = setNotice;
    const automations = {
      listing: LISTING,
      watchingSince: null,
      pauses: { isPaused: () => false },
      planZone: null,
      notice,
      setNotice,
      busy: false,
      error: null,
      setEnabled: vi.fn(() => flip(setNotice)),
    } as unknown as AutomationsController;
    return (
      <AutomationsScreen
        automations={automations}
        ports={PORTS}
        clock={CLOCK}
        indexKey="k"
        activity={recordingActivity()}
        vault={null}
        onOpenNote={vi.fn()}
        offersClaude
        presets={[]}
      />
    );
  }
  render(<Runner />, { wrapper: queryWrapper().wrapper });
  const turnOff = async () => {
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Turn off/ }));
    });
  };
  return { turnOff, said };
}

describe('what the read-twice offer’s Turn off says (#793)', () => {
  it('says the runner’s own reason when the write failed', async () => {
    const { turnOff } = renderScreen(async (say) => {
      say('“Pull actions” was changed on disk since it was read.');
      return null;
    });

    await turnOff();

    expect(screen.getByRole('status').textContent).toBe(
      '“Pull actions” was changed on disk since it was read.',
    );
  });

  it('says it was not turned off when the runner said nothing, until something newer is said', async () => {
    const { turnOff, said } = renderScreen(async () => null);

    await turnOff();
    expect(screen.getByRole('status').textContent).toMatch(/was not turned off/);

    act(() => said.say('Saved “Pull actions”.'));

    expect(screen.getByRole('status').textContent).toBe('Saved “Pull actions”.');
  });
});

// @vitest-environment jsdom
/**
 * Adversarial pass on PR #643 (#191): the offer as the window holds it, when
 * the vault changes under a yes in flight, and which rules hide it on the
 * Inbox. Each `it.fails` is a bug found; the fix flips it to `it`.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AFTER_A_MEETING_PRESET, type AutomationRule } from '@dfai/domain';
import {
  acceptMeetingSetup,
  fakeMarkdown,
  fakeVaultFs,
  previewMeetingSetup,
  recordingActivity,
  type MeetingSetupDone,
  type MeetingSetupOffer,
} from '@dfai/application';
import {
  createAutomationsStore,
  publishAutomations,
  type AutomationsController,
  type AutomationsStore,
} from '../automations/automations-store.ts';
import {
  createMeetingSetupStore,
  useMeetingSetup,
  type MeetingSetupWiring,
} from './use-meeting-setup.ts';

vi.mock('@dfai/application', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  previewMeetingSetup: vi.fn(),
  acceptMeetingSetup: vi.fn(),
}));

const preview = vi.mocked(previewMeetingSetup);
const accept = vi.mocked(acceptMeetingSetup);

const OFFER: MeetingSetupOffer = {
  rule: AFTER_A_MEETING_PRESET,
  prompt: null,
  extensions: [],
  asksEmails: true,
  lines: [
    {
      kind: 'rule',
      what: 'The “After a meeting” rule',
      detail: 'Written.',
      written: true,
      blocked: false,
    },
  ],
  ruleOn: false,
};

function rulesRead(store: AutomationsStore, rules: readonly AutomationRule[]) {
  const listing = {
    automations: rules.map((rule) => ({ rule, log: [], idWritten: true })),
    broken: [],
  };
  publishAutomations(store, { listing } as unknown as AutomationsController);
}

function setup(where: 'inbox' | 'automations' = 'inbox') {
  const automations = createAutomationsStore();
  const activity = recordingActivity();
  const wiring: MeetingSetupWiring = {
    store: createMeetingSetupStore(),
    automations,
    fs: fakeVaultFs(),
    markdown: fakeMarkdown(),
    suggestedEmails: ['mara.quill@example.com'],
    activity,
    onChanged: vi.fn(),
  };
  const hook = renderHook(({ vault }) => useMeetingSetup(wiring, { vault, where }), {
    initialProps: { vault: '/vaults/larkspur' as string | null },
  });
  return { hook, wiring, automations, activity };
}

describe('useMeetingSetup (attack #643)', () => {
  it('a yes still running in one vault leaves the next vault’s open preview alone', async () => {
    preview.mockReset().mockResolvedValue(OFFER);
    let finish: (done: MeetingSetupDone) => void = () => {};
    accept.mockReset().mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const { hook } = setup('automations');
    act(() => hook.result.current?.onOpen());
    await waitFor(() => expect(hook.result.current?.lines).not.toBeNull());
    act(() => hook.result.current?.onAccept());
    hook.rerender({ vault: '/vaults/fenn' });
    act(() => hook.result.current?.onOpen());
    await waitFor(() => expect(hook.result.current?.lines).not.toBeNull());
    await act(async () => {
      finish({
        written: ['Turned on “After a meeting”.'],
        failed: [],
        refused: null,
        ruleOn: true,
      });
      await Promise.resolve();
    });
    // The yes was said in /vaults/larkspur; the preview open in /vaults/fenn must survive it.
    await waitFor(() => expect(hook.result.current?.open).toBe(true));
    expect(hook.result.current?.lines).toEqual(OFFER.lines);
  });

  it('on the Inbox, still offers the setup while the only meeting rule is turned off', () => {
    const { hook, automations } = setup();
    const off = {
      ...AFTER_A_MEETING_PRESET,
      enabled: false,
      id: 'after-a-meeting',
      path: '.atlas/automations/After a meeting.md',
    } as AutomationRule;
    act(() => rulesRead(automations, [off]));
    expect(hook.result.current).not.toBeNull();
  });
});

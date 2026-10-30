// @vitest-environment jsdom
/**
 * The offer to set meeting post-processing up in one yes (#191), as the
 * window holds it: nothing is read until the preview is asked for, the Inbox
 * shows it only while no rule post-processes meetings, and the yes says what
 * it wrote in the offer and in Activity.
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
  lines: [{ kind: 'rule', what: 'The “After a meeting” rule', detail: 'Written.', written: true }],
  ruleOn: false,
};

/** Opens the preview and says yes, as the person does, and waits for what the yes said. */
async function sayYes(hook: ReturnType<typeof setup>['hook']) {
  act(() => hook.result.current?.onOpen());
  await waitFor(() => expect(hook.result.current?.lines).not.toBeNull());
  act(() => hook.result.current?.onAccept());
  await waitFor(() => expect(hook.result.current?.busy).toBe(false));
  await waitFor(() =>
    expect(hook.result.current?.result ?? hook.result.current?.problem).not.toBeNull(),
  );
}

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

describe('useMeetingSetup', () => {
  it('on the Inbox, waits for the rules, shows while none post-processes meetings, and reads nothing', () => {
    preview.mockReset();
    const { hook, automations } = setup();
    expect(hook.result.current).toBeNull();
    act(() => rulesRead(automations, []));
    expect(hook.result.current?.open).toBe(false);
    expect(hook.result.current?.dismissable).toBe(true);
    expect(preview).not.toHaveBeenCalled();
    const rule = { ...AFTER_A_MEETING_PRESET, id: 'x', path: 'x.md' } as AutomationRule;
    act(() => rulesRead(automations, [rule]));
    expect(hook.result.current).toBeNull();
  });

  it('on Automations, always stands, with no "Not now"', () => {
    const { hook } = setup('automations');
    expect(hook.result.current?.dismissable).toBe(false);
  });

  it('shows nothing with no vault open', () => {
    const { hook } = setup('automations');
    hook.rerender({ vault: null });
    expect(hook.result.current).toBeNull();
  });

  it('"Not now" puts it away on the Inbox until another vault opens', () => {
    const { hook, automations } = setup();
    act(() => rulesRead(automations, []));
    act(() => hook.result.current?.onClose());
    expect(hook.result.current).toBeNull();
    hook.rerender({ vault: '/vaults/other' });
    expect(hook.result.current).not.toBeNull();
  });

  it('previews on asking, starting the field from the addresses in use', async () => {
    preview.mockReset().mockResolvedValue(OFFER);
    const { hook, automations } = setup();
    act(() => rulesRead(automations, []));
    act(() => hook.result.current?.onOpen());
    expect(hook.result.current?.open).toBe(true);
    expect(hook.result.current?.lines).toBeNull();
    await waitFor(() => expect(hook.result.current?.lines).toEqual(OFFER.lines));
    expect(hook.result.current?.asksEmails).toBe(true);
    expect(hook.result.current?.emails).toBe('mara.quill@example.com');
    act(() => hook.result.current?.onEmailsChange('tobias.fenn@example.com'));
    expect(hook.result.current?.emails).toBe('tobias.fenn@example.com');
    act(() => hook.result.current?.onClose());
    expect(hook.result.current?.open).toBe(false);
  });

  it('says why the preview could not be read', async () => {
    preview.mockReset().mockRejectedValue(new Error('the disk is gone'));
    const { hook } = setup('automations');
    act(() => hook.result.current?.onOpen());
    await waitFor(() => expect(hook.result.current?.problem).toContain('the disk is gone'));
    expect(hook.result.current?.open).toBe(false);
  });

  it('says yes with what was typed, then says what it wrote, in Activity too', async () => {
    preview.mockReset().mockResolvedValue(OFFER);
    accept.mockReset().mockResolvedValue({
      written: ['Turned on “After a meeting”.'],
      failed: [{ what: 'The Task type', reason: 'No.' }],
      refused: null,
      ruleOn: true,
    });
    const { hook, wiring, activity } = setup('automations');
    act(() => hook.result.current?.onOpen());
    await waitFor(() => expect(hook.result.current?.lines).not.toBeNull());
    act(() => hook.result.current?.onAccept());
    await waitFor(() => expect(hook.result.current?.result).not.toBeNull());
    expect(accept).toHaveBeenCalledWith(
      expect.objectContaining({ offer: OFFER, emails: 'mara.quill@example.com' }),
    );
    expect(hook.result.current?.open).toBe(false);
    expect(hook.result.current?.problem).toBe('The Task type could not be set up: No.');
    expect(activity.reports.map((report) => [report.level, report.message])).toEqual([
      ['info', 'Turned on “After a meeting”.'],
      ['warning', 'The Task type could not be set up: No.'],
    ]);
    expect(wiring.onChanged).toHaveBeenCalledOnce();
    act(() => hook.result.current?.onDismiss());
    expect(hook.result.current?.result).toBeNull();
  });

  it('keeps the preview open when the addresses typed are refused, writing nothing', async () => {
    preview.mockReset().mockResolvedValue(OFFER);
    accept
      .mockReset()
      .mockResolvedValue({ written: [], failed: [], refused: 'Not an address.', ruleOn: false });
    const { hook, wiring } = setup('automations');
    act(() => hook.result.current?.onOpen());
    await waitFor(() => expect(hook.result.current?.lines).not.toBeNull());
    act(() => hook.result.current?.onAccept());
    await waitFor(() => expect(hook.result.current?.problem).toBe('Not an address.'));
    expect(hook.result.current?.open).toBe(true);
    expect(wiring.onChanged).not.toHaveBeenCalled();
  });

  it('says so when nothing needed writing', async () => {
    preview.mockReset().mockResolvedValue(OFFER);
    accept.mockReset().mockResolvedValue({ written: [], failed: [], refused: null, ruleOn: true });
    const { hook, wiring } = setup('automations');
    act(() => hook.result.current?.onOpen());
    await waitFor(() => expect(hook.result.current?.lines).not.toBeNull());
    act(() => hook.result.current?.onAccept());
    await waitFor(() => expect(hook.result.current?.result).toContain('set up already'));
    expect(wiring.onChanged).not.toHaveBeenCalled();
  });

  it('says the rule is on, with what failed, when the rule was written but a part was not', async () => {
    preview.mockReset().mockResolvedValue(OFFER);
    accept.mockReset().mockResolvedValue({
      written: ['Turned on “After a meeting”.'],
      failed: [{ what: 'The Task type', reason: 'No.' }],
      refused: null,
      ruleOn: true,
    });
    const { hook } = setup('automations');
    await sayYes(hook);
    expect(hook.result.current?.result).toBe(
      'Meetings are processed when they arrive, but some parts could not be set up.',
    );
  });

  it('never says it was set up already when every part failed', async () => {
    preview.mockReset().mockResolvedValue(OFFER);
    accept.mockReset().mockResolvedValue({
      written: [],
      failed: [
        { what: 'The Task type', reason: 'read-only' },
        { what: 'The “After a meeting” rule', reason: 'read-only' },
      ],
      refused: null,
      ruleOn: false,
    });
    const { hook } = setup('automations');
    await sayYes(hook);
    expect(hook.result.current?.result).toBe(
      'Meetings are not processed yet: some parts could not be set up.',
    );
    expect(hook.result.current?.problem).toContain('read-only');
  });

  it('never says meetings are processed when the rule could not be written', async () => {
    preview.mockReset().mockResolvedValue(OFFER);
    accept.mockReset().mockResolvedValue({
      written: ['The Task type gained meeting, atlas_item.', 'Saved your emails: m@example.com.'],
      failed: [{ what: 'The “After a meeting” rule', reason: 'No.' }],
      refused: null,
      ruleOn: false,
    });
    const { hook } = setup('automations');
    await sayYes(hook);
    expect(hook.result.current?.result).toBe(
      'Meetings are not processed yet: some parts could not be set up.',
    );
  });

  it('says meetings are not processed yet when nothing failed but no rule is on', async () => {
    preview.mockReset().mockResolvedValue(OFFER);
    accept.mockReset().mockResolvedValue({ written: [], failed: [], refused: null, ruleOn: false });
    const { hook } = setup('automations');
    await sayYes(hook);
    expect(hook.result.current?.result).toBe(
      'Meetings are not processed yet: no rule that does it is on. The preview said why.',
    );
  });

  it('says why a write the runner caught failed, not that the vault closed', async () => {
    preview.mockReset().mockResolvedValue(OFFER);
    accept.mockReset().mockRejectedValue(new Error('the settings are locked'));
    const { hook, automations } = setup('automations');
    // As the runner does: an error inside is caught there and answered as null.
    const exclusive = async (task: (vault: string) => Promise<unknown>) => {
      try {
        return await task('/v');
      } catch {
        return null;
      }
    };
    publishAutomations(automations, {
      listing: null,
      exclusive,
    } as unknown as AutomationsController);
    await sayYes(hook);
    expect(hook.result.current?.problem).toContain('the settings are locked');
    expect(hook.result.current?.problem).not.toContain('the vault closed');
  });

  it('tells the offer whether the yes would write anything, as the plan says', async () => {
    const nothing: MeetingSetupOffer = { ...OFFER, rule: null, asksEmails: false, ruleOn: true };
    preview.mockReset().mockResolvedValue(nothing);
    const { hook } = setup('automations');
    act(() => hook.result.current?.onOpen());
    await waitFor(() => expect(hook.result.current?.lines).not.toBeNull());
    expect(hook.result.current?.writesNothing).toBe(true);
    preview.mockReset().mockResolvedValue(OFFER);
    act(() => hook.result.current?.onOpen());
    await waitFor(() => expect(hook.result.current?.writesNothing).toBe(false));
  });

  it('writes through the automations’ runner, one at a time with its runs', async () => {
    preview.mockReset().mockResolvedValue(OFFER);
    accept
      .mockReset()
      .mockResolvedValue({ written: ['x'], failed: [], refused: null, ruleOn: true });
    const { hook, automations } = setup('automations');
    const exclusive = vi.fn(async (task: (vault: string) => Promise<unknown>) => task('/v'));
    publishAutomations(automations, {
      listing: null,
      exclusive,
    } as unknown as AutomationsController);
    act(() => hook.result.current?.onOpen());
    await waitFor(() => expect(hook.result.current?.lines).not.toBeNull());
    act(() => hook.result.current?.onAccept());
    await waitFor(() => expect(hook.result.current?.result).not.toBeNull());
    expect(exclusive).toHaveBeenCalledWith(expect.any(Function), { wait: true });
  });

  it('says when the runner had no vault to write in, or the write threw', async () => {
    preview.mockReset().mockResolvedValue(OFFER);
    const { hook, automations } = setup('automations');
    publishAutomations(automations, {
      listing: null,
      exclusive: async () => null,
    } as unknown as AutomationsController);
    act(() => hook.result.current?.onOpen());
    await waitFor(() => expect(hook.result.current?.lines).not.toBeNull());
    act(() => hook.result.current?.onAccept());
    await waitFor(() => expect(hook.result.current?.problem).toContain('the vault closed'));
    publishAutomations(automations, null);
    accept.mockReset().mockRejectedValue('locked');
    act(() => hook.result.current?.onOpen());
    await waitFor(() => expect(hook.result.current?.lines).not.toBeNull());
    act(() => hook.result.current?.onAccept());
    await waitFor(() => expect(hook.result.current?.problem).toContain('locked'));
  });
});

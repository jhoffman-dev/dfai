import { useCallback, useMemo } from 'react';
import { createStore, useStore, type StoreApi } from 'zustand';
import { meetingSetupWritesNothing, meetingsProcessedOnArrival } from '@dfai/domain';
import {
  acceptMeetingSetup,
  previewMeetingSetup,
  type ActivityRecorder,
  type MarkdownPort,
  type MeetingSetupDone,
  type MeetingSetupOffer,
  type VaultFsPort,
} from '@dfai/application';
import type { MeetingSetupProps } from '@dfai/ui';
import type { AutomationsStore } from '../automations/automations-store.ts';
import { vaultSettingsWriter } from '../settings/vault-settings-writer.ts';
import { localClock } from '../today.ts';

/** Where the offer stands in one vault: the window's, so the Inbox and Automations share it. */
interface MeetingSetupState {
  readonly vault: string | null;
  /** Put away on the Inbox until the vault is opened again. */
  readonly dismissed: boolean;
  readonly open: boolean;
  /** What the preview lists; null until it is read. */
  readonly offer: MeetingSetupOffer | null;
  readonly emails: string;
  readonly busy: boolean;
  readonly result: string | null;
  readonly problem: string | null;
}

export type MeetingSetupStore = StoreApi<MeetingSetupState>;

const FRESH = {
  dismissed: false,
  open: false,
  offer: null,
  emails: '',
  busy: false,
  result: null,
  problem: null,
} as const;

/** Where the offer stands in a vault nothing has been done in yet. */
const IDLE: MeetingSetupState = { vault: null, ...FRESH };

export function createMeetingSetupStore(): MeetingSetupStore {
  return createStore<MeetingSetupState>()(() => IDLE);
}

/** What the offer needs from the window. */
export interface MeetingSetupWiring {
  readonly store: MeetingSetupStore;
  /** The rules as their runner holds them: the Inbox offers the setup only while none does it. */
  readonly automations: AutomationsStore;
  readonly fs: VaultFsPort;
  readonly markdown: MarkdownPort;
  /** The owner's addresses in use, to start the field from: only a suggestion until saved. */
  readonly suggestedEmails: readonly string[];
  readonly activity: ActivityRecorder;
  /** After the yes wrote anything, so the types and the tree are read again. */
  readonly onChanged: () => void;
  /**
   * Whether the platform can run the Claude rules the set-up installs (#657):
   * where not, it is offered nowhere.
   */
  readonly offered: boolean;
}

/**
 * The offer to set up meeting post-processing in one previewed yes (#191).
 * Nothing is read for it until the person asks for the preview, so opening a
 * vault or the Inbox costs nothing more. On the Inbox it shows only while no
 * rule post-processes meetings, as the rules already read say; on the
 * Automations page (`where: 'automations'`) it is always a click away. Null
 * when there is nothing to show.
 */
export function useMeetingSetup(
  wiring: MeetingSetupWiring,
  { vault, where }: { vault: string | null; where: 'inbox' | 'automations' },
): MeetingSetupProps | null {
  const { store, automations } = wiring;
  const held = useStore(store);
  // One object while another vault's state is held, so the props stay the same across renders.
  const state = held.vault === vault ? held : IDLE;
  // Null until the rules are read: whether the Inbox needs the offer is not known yet.
  const needed = useStore(automations, (s) => {
    const listing = s.automations?.listing ?? null;
    if (listing === null) return null;
    return !meetingsProcessedOnArrival(listing.automations.map(({ rule }) => rule));
  });
  const commands = useSetupCommands(wiring, vault);
  return useMemo(() => {
    const busyOrSaid = state.open || state.result !== null || state.problem !== null;
    const shown = where === 'automations' || busyOrSaid || (needed !== false && !state.dismissed);
    if (vault === null || !shown || !wiring.offered) return null;
    const offer = state.offer;
    return {
      // Said while the rules are read, so the Inbox holds its rows rather than
      // let the offer land above them once they are drawn (#130).
      reading: where === 'inbox' && !busyOrSaid && needed === null,
      open: state.open,
      lines: offer === null ? null : offer.lines,
      asksEmails: offer?.asksEmails ?? false,
      writesNothing: offer !== null && meetingSetupWritesNothing(offer),
      emails: state.emails,
      busy: state.busy,
      result: state.result,
      problem: state.problem,
      dismissable: where === 'inbox',
      ...commands,
    };
  }, [state, needed, where, vault, commands]);
}

type SetupCommands = Pick<
  MeetingSetupProps,
  'onOpen' | 'onEmailsChange' | 'onAccept' | 'onClose' | 'onDismiss'
>;

function useSetupCommands(wiring: MeetingSetupWiring, vault: string | null): SetupCommands {
  const { store } = wiring;
  // What the person does here starts this vault's state afresh if another vault's is held.
  const change = useCallback(
    (next: Partial<MeetingSetupState>) =>
      store.setState((was) => ({ ...(was.vault === vault ? was : { vault, ...FRESH }), ...next })),
    [store, vault],
  );
  // What a read or a write says once it is done lands only in the vault it started in.
  const settle = useCallback(
    (next: Partial<MeetingSetupState>) =>
      store.setState((was) => (was.vault === vault ? { ...was, ...next } : was)),
    [store, vault],
  );
  const onOpen = useCallback(() => {
    change({ open: true, offer: null, result: null, problem: null });
    previewMeetingSetup(wiring).then(
      (offer) =>
        settle({ offer, emails: offer.asksEmails ? wiring.suggestedEmails.join(', ') : '' }),
      (cause: unknown) =>
        settle({ open: false, problem: `Could not read the vault: ${messageOf(cause)}` }),
    );
  }, [change, settle, wiring]);
  const onAccept = useCallback(() => {
    const { offer, emails, busy, vault: held } = store.getState();
    // A second click while the first yes is written would replace what that one says.
    if (held !== vault || offer === null || busy) return;
    change({ busy: true, problem: null });
    void accept(wiring, { offer, emails }).then((said) => settle({ busy: false, ...said }));
  }, [change, settle, store, wiring, vault]);
  return useMemo(
    () => ({
      onOpen,
      onAccept,
      onEmailsChange: (emails: string) => change({ emails }),
      onClose: () =>
        change(store.getState().open ? { open: false } : { dismissed: true, open: false }),
      onDismiss: () => change({ result: null, problem: null }),
    }),
    [onOpen, onAccept, change, store],
  );
}

/**
 * Says yes, through the automations' runner when it is there so no rule runs
 * while the rule and its keys are written, and says how it went: in the offer
 * and, each part, in Activity.
 */
async function accept(
  wiring: MeetingSetupWiring,
  { offer, emails }: { offer: MeetingSetupOffer; emails: string },
): Promise<Partial<MeetingSetupState>> {
  const { fs, markdown } = wiring;
  // Caught here, not by the runner: it answers an error with null, which would read as a closed vault.
  const write = async (): Promise<Written> => {
    try {
      const settings = vaultSettingsWriter({ fs, markdown });
      return {
        done: await acceptMeetingSetup({
          fs,
          markdown,
          clock: localClock,
          settings,
          offer,
          emails,
        }),
      };
    } catch (cause) {
      return { thrown: cause };
    }
  };
  const exclusive = wiring.automations.getState().automations?.exclusive;
  const written = exclusive === undefined ? await write() : await exclusive(write, { wait: true });
  if (written === null)
    return { problem: 'Meeting processing could not be set up: the vault closed.' };
  if ('thrown' in written) {
    return { problem: `Meeting processing could not be set up: ${messageOf(written.thrown)}` };
  }
  return settled(wiring, written.done);
}

/** What the yes came to: what it did, or what it threw. */
type Written = { readonly done: MeetingSetupDone } | { readonly thrown: unknown };

function settled(wiring: MeetingSetupWiring, done: MeetingSetupDone): Partial<MeetingSetupState> {
  if (done.refused !== null) return { problem: done.refused };
  for (const message of done.written) {
    wiring.activity.record({ level: 'info', kind: 'app', message, subject: null });
  }
  const failures = done.failed.map(({ what, reason }) => `${what} could not be set up: ${reason}`);
  for (const message of failures) {
    wiring.activity.record({ level: 'warning', kind: 'app', message, subject: null });
  }
  if (done.written.length > 0) wiring.onChanged();
  return {
    open: false,
    offer: null,
    result: resultOf(done),
    problem: failures.length === 0 ? null : failures.join(' '),
  };
}

/** What the yes did, by whether a rule now processes meetings and whether any part failed. */
function resultOf({ ruleOn, failed, written }: MeetingSetupDone): string {
  if (!ruleOn) {
    return failed.length > 0
      ? 'Meetings are not processed yet: some parts could not be set up.'
      : 'Meetings are not processed yet: no rule that does it is on. The preview said why.';
  }
  if (failed.length > 0) {
    return 'Meetings are processed when they arrive, but some parts could not be set up.';
  }
  return written.length === 0
    ? 'Nothing needed writing: meeting processing was set up already.'
    : 'Meetings are processed when they arrive. Activity lists what was written.';
}

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
